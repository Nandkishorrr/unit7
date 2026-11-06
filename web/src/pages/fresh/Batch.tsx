// One batch of updates as a story: Find → Apply → Test → Staging → Check → Accept → Release → Watch, each step a
// StatusMark and one plain line (hover says what the step is for). What changes for you in three lines, the libraries
// with the security reason in plain words and the advisory link, Release or Hold until…, and under Advanced the
// lockfile diff, the page checks and the release notes. The Release and Watch steps open the release's own timeline
// (the same one deploys show).
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, CalendarClock, ChevronDown, Eye, GitPullRequest, Package, PauseCircle, Rocket, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
import { act, Badge, Button, cx, HoverCard, Input, Modal, Skeleton, StatusMark, type MarkState } from '../../ui';
import { onLive, runTool } from '../../lib/api';
import { AskButton } from '../Help';
import { ReleaseTimeline, dur } from '../release';
import { STEPS, SEV_TONE, SEV_WORDS, ended, major, nice, stepsOf, useLiveSteps, type Batch, type Item, type Planned, type Step } from './data';

const MARK: Record<Step['state'], MarkState> = { done: 'ok', active: 'work', failed: 'bad', skipped: 'off', waiting: 'warn', todo: 'off' };
const labelOf = (k: string) => STEPS.find((s) => s.key === k)?.label ?? k;
const saysOf = (k: string) => STEPS.find((s) => s.key === k)?.says ?? '';
const stateWord = (s: Step['state']) => ({ done: 'done', active: 'working on it', failed: 'stopped here', skipped: 'not needed', waiting: 'waiting for you', todo: 'not yet' })[s];

// --- the eight steps -----------------------------------------------------------------------------------------------------
// compact (a card): eight small marks in a row and the step at work in one line; the pop-up has the full story
function MiniSteps({ steps, className }: { steps: Step[]; className?: string }) {
  const all = stepsOf({ steps });
  const at = all.find((s) => s.state === 'failed') ?? all.find((s) => s.state === 'active' || s.state === 'waiting') ?? all.filter((s) => s.state !== 'todo').at(-1);
  return (
    <div className={cx('min-w-0', className)}>
      <ol className="flex items-center gap-1" aria-label="Update steps">
        {all.map((st, i) => (
          <li key={st.key} className="flex min-w-0 flex-1 items-center gap-1">
            <StatusMark state={MARK[st.state]} size={16} solid={st.state === 'done'} label={`${labelOf(st.key)}: ${stateWord(st.state)}`} className={cx(st.state === 'todo' && 'opacity-50')} />
            {i < all.length - 1 && <span aria-hidden className={cx('h-0.5 min-w-1 flex-1 rounded-full', st.state === 'done' || st.state === 'skipped' ? 'bg-ok/45' : 'bg-line-strong')} />}
          </li>
        ))}
      </ol>
      {at && <p className="mt-1.5 truncate text-[12px] text-ink-2"><span className="font-medium text-ink">{labelOf(at.key)}</span> · {at.note || saysOf(at.key)}</p>}
    </div>
  );
}

export function FreshTimeline({ compact, ...p }: { steps: Step[]; deploymentId?: string | null; compact?: boolean; className?: string }) {
  return compact ? <MiniSteps steps={p.steps} className={p.className} /> : <Full {...p} />;
}
function Full({ steps, deploymentId, className }: { steps: Step[]; deploymentId?: string | null; className?: string }) {
  const compact = false;
  const all = stepsOf({ steps });
  const at = all.find((s) => s.state === 'failed') ?? all.find((s) => s.state === 'active' || s.state === 'waiting');
  const [picked, setPicked] = useState<string | null>(null);
  const focus = all.find((s) => s.key === picked) ?? at;
  const [now, setNow] = useState(() => Date.now());
  const going = all.some((s) => s.state === 'active');
  useEffect(() => { if (!going) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [going]);
  return (
    <div className={cx('@container min-w-0', className)}>
      <ol className="grid gap-1 @lg:grid-cols-8 @lg:gap-0" aria-label="Update steps">
        {all.map((st, i) => {
          const on = focus?.key === st.key;
          return (
            <li key={st.key} className="relative min-w-0">
              {i < all.length - 1 && <span aria-hidden className={cx('absolute hidden h-0.5 rounded-full @lg:block', 'left-[calc(50%+14px)] right-[calc(-50%+14px)] top-[12px]', st.state === 'done' || st.state === 'skipped' ? 'bg-ok/45' : 'bg-line-strong')} />}
              <HoverCard content={<div className="max-w-[250px]"><p className="font-medium">{labelOf(st.key)}</p><p className="mt-0.5 text-[12.5px] text-ink-2">{saysOf(st.key)}</p>{st.note && <p className="mt-1.5 text-[12px] text-muted">{st.note}</p>}</div>}>
                <button type="button" onClick={() => setPicked(on && picked ? null : st.key)} aria-pressed={on}
                  className={cx('flex w-full min-w-0 items-center gap-2 rounded-[12px] px-1.5 py-1 text-left transition-colors @lg:flex-col @lg:gap-1 @lg:text-center', on ? 'bg-raised' : 'hover:bg-raised/60', st.state === 'todo' && 'opacity-50')}>
                  <StatusMark state={MARK[st.state]} size={compact ? 20 : 24} solid={st.state === 'done'} label={`${labelOf(st.key)}: ${stateWord(st.state)}`} />
                  <span className="min-w-0 flex-1 @lg:flex-none">
                    <span className={cx('block truncate text-[12px] font-medium leading-tight', st.state === 'failed' ? 'text-bad' : st.state === 'waiting' ? 'text-warn' : st.state === 'active' ? 'text-ink' : 'text-ink-2')}>{labelOf(st.key)}</span>
                    <span className="tabular block text-[11px] text-muted @lg:min-h-[14px]">{st.state === 'active' && st.at ? dur(now - Date.parse(st.at)) : st.state === 'done' || st.state === 'failed' ? dur(st.ms) : ''}</span>
                  </span>
                  {st.note && <span className="line-clamp-2 min-w-0 flex-[2] text-[12px] text-muted @lg:hidden">{st.note}</span>}
                </button>
              </HoverCard>
            </li>
          );
        })}
      </ol>
      {focus && !compact && (
        <div className={cx('mt-2 rounded-[14px] px-3 py-2.5 text-[12.5px] animate-rise', focus.state === 'failed' ? 'bg-bad/8 text-bad' : focus.state === 'waiting' ? 'bg-warn/10 text-ink-2' : 'bg-raised/70 text-ink-2')}>
          <p><span className="font-medium">{labelOf(focus.key)}</span> · {focus.note || saysOf(focus.key)}</p>
          {(focus.key === 'release' || focus.key === 'watch') && deploymentId && focus.state !== 'todo' && <ReleaseTimeline deploymentId={deploymentId} compact className="mt-3 rounded-[12px] bg-surface p-3" />}
        </div>
      )}
    </div>
  );
}

// --- the libraries -------------------------------------------------------------------------------------------------------
const BUMP = { patch: 'Patch', minor: 'Minor', major: 'Major' } as const;
function Library({ i, onHold }: { i: Item; onHold?: (name: string) => void }) {
  const worst = i.security?.[0];
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
      <Package size={15} className="shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-ink">{nice(i.name)}{nice(i.name).toLowerCase() !== i.name.toLowerCase() && <span className="ml-1.5 font-mono text-[11.5px] font-normal text-muted">{i.name}</span>}</span>
        <span className="tabular block font-mono text-[11.5px] text-muted">{i.from} → {i.to}{i.dev ? ' · only while building' : ''}</span>
      </span>
      {worst && (
        <HoverCard content={<div className="max-w-[280px] space-y-1.5"><p className="font-medium text-ink">{SEV_WORDS[worst.severity]} security problem</p>{i.security!.slice(0, 3).map((s) => <p key={s.id} className="text-[12.5px] text-ink-2">{s.summary}{s.fixed ? ` Fixed in ${s.fixed}.` : ''} <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center font-medium text-blue-text hover:underline">Read it<ArrowUpRight size={11} /></a></p>)}</div>}>
          <span tabIndex={0}><Badge tone={SEV_TONE[worst.severity]} className="cursor-help"><ShieldAlert size={11} className="mr-1 inline align-[-1px]" aria-hidden />{SEV_WORDS[worst.severity]}</Badge></span>
        </HoverCard>
      )}
      <Badge tone={i.bump === 'major' ? 'warn' : 'neutral'}>{BUMP[i.bump]}</Badge>
      {onHold && <button type="button" onClick={() => onHold(i.name)} className="text-[12px] font-medium text-muted underline decoration-line-strong underline-offset-4 hover:text-ink">Hold</button>}
    </li>
  );
}

// "Fixes a security problem in lodash…" in plain words, with the advisory a click away
function Security({ items }: { items: Item[] }) {
  const sec = items.filter((i) => i.security?.length);
  if (!sec.length) return null;
  return (
    <section aria-label="Security fixes" className="rounded-[18px] border border-bad/25 bg-bad/5 p-3.5">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-ink"><ShieldAlert size={15} className="text-bad" aria-hidden />Why this matters</p>
      <ul className="mt-1.5 space-y-1.5">
        {sec.slice(0, 4).map((i) => i.security!.slice(0, 1).map((s) => (
          <li key={`${i.name}-${s.id}`} className="text-[12.5px] leading-snug text-ink-2">
            <span className="font-medium text-ink">{nice(i.name)}</span>: {s.summary.replace(/\.$/, '')}. {s.severity === 'critical' || s.severity === 'high' ? 'Attackers know about it, so it goes out the same day.' : 'It goes out with the weekly updates.'}{' '}
            <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-blue-text hover:underline">The advisory<ArrowUpRight size={11} aria-hidden /></a>
          </li>
        )))}
      </ul>
    </section>
  );
}

const LINE_ICON = [ShieldCheck, Sparkles, Eye];
function Changes({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <section aria-label="What changes for you">
      <h3 className="text-[13px] font-semibold text-ink">What changes for you</h3>
      <ul className="mt-2 space-y-1.5">
        {lines.map((l, k) => { const I = /security/i.test(l) ? ShieldCheck : /visitors/i.test(l) ? Eye : LINE_ICON[Math.min(k, 2)]!; return (
          <li key={k} className="flex items-start gap-2.5 text-[13px] leading-snug text-ink-2 animate-rise" style={{ animationDelay: `${k * 60}ms` }}>
            <span aria-hidden className={cx('mt-px grid size-5 shrink-0 place-items-center rounded-full', /security/i.test(l) ? 'bg-bad/10 text-bad' : /visitors/i.test(l) ? 'bg-ok/12 text-ok' : 'bg-blue-soft text-blue-text')}><I size={11.5} strokeWidth={2.4} /></span>{l}
          </li>
        ); })}
      </ul>
    </section>
  );
}

function Advanced({ b }: { b: Batch }) {
  const notes = Object.entries(b.notes ?? {});
  if (!b.diff && !b.files && !b.smoke?.rows.length && !notes.length && !b.tests?.failure) return null;
  return (
    <details className="group rounded-[16px] border border-line">
      <summary className="flex cursor-pointer list-none items-center gap-1 px-3.5 py-2.5 text-[12.5px] font-medium text-muted hover:text-ink">Advanced<ChevronDown size={13} className="transition-transform group-open:rotate-180" /></summary>
      <div className="space-y-3 px-3.5 pb-3.5 text-[12.5px]">
        {b.tests?.failure && <p className="text-ink-2"><span className="font-medium text-ink">Tests{b.tests.label ? ` (${b.tests.label})` : ''}:</span> {b.tests.failure}</p>}
        {b.smoke?.rows.length ? (
          <div>
            <p className="font-medium text-ink">Pages checked on the copy</p>
            <table className="mt-1 w-full text-left text-[12px]"><thead className="text-muted"><tr><th className="py-1 font-medium">Page</th><th className="font-medium">Live</th><th className="font-medium">Copy</th></tr></thead>
              <tbody className="tabular">{b.smoke.rows.map((r) => <tr key={r.path} className={cx('border-t border-line', !r.ok && 'text-bad')}><td className="max-w-[220px] truncate py-1 font-mono">{r.path}</td><td>{r.live || '–'} · {r.liveMs} ms</td><td>{r.copy || '–'} · {r.copyMs} ms</td></tr>)}</tbody></table>
          </div>
        ) : null}
        {b.files && <div><p className="font-medium text-ink">Files changed</p><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-[12px] bg-[#111115] p-3 font-mono text-[11px] text-white/80">{b.files}</pre></div>}
        {b.diff && <div><p className="font-medium text-ink">What changed in the lockfile and manifests</p><pre className="mt-1 max-h-64 overflow-auto rounded-[12px] bg-[#111115] p-3 font-mono text-[11px] leading-relaxed">{b.diff.split('\n').map((l, k) => <span key={k} className={cx('block', l.startsWith('+') && !l.startsWith('+++') ? 'text-[#a3e635]' : l.startsWith('-') && !l.startsWith('---') ? 'text-[#fca5a5]' : 'text-white/60')}>{l || ' '}</span>)}</pre></div>}
        {notes.map(([name, lines]) => <div key={name}><p className="font-medium text-ink">From {nice(name)}’s release notes</p><ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">{lines.map((l) => <li key={l}>{l}</li>)}</ul></div>)}
      </div>
    </details>
  );
}

// --- holding back ----------------------------------------------------------------------------------------------------------
const plusDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
export function HoldDialog({ open, onClose, serviceId, pkg, app, onDone }: { open: boolean; onClose: () => void; serviceId?: string; pkg?: string; app?: string; onDone?: () => void }) {
  const [pick, setPick] = useState<'week' | 'month' | 'date' | 'forever'>('month');
  const [date, setDate] = useState(plusDays(14));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setPick('month'); setReason(''); } }, [open]);
  const until = pick === 'week' ? plusDays(7) : pick === 'month' ? plusDays(30) : pick === 'date' ? date : undefined;
  const save = async () => {
    setBusy(true);
    const r = await act('fresh.hold', { ...(serviceId && { serviceId }), ...(pkg && { package: pkg }), ...(until && { until }), ...(reason.trim() && { reason: reason.trim() }) }, { success: pkg ? `${nice(pkg)} is held back` : `Updates for ${app ?? 'this app'} are paused` });
    setBusy(false);
    if (r) { onClose(); onDone?.(); }
  };
  const opts = [['week', 'For a week'], ['month', 'For a month'], ['date', 'Until a date'], ['forever', 'Until I say']] as const;
  return (
    <Modal open={open} onClose={onClose} title={pkg ? `Hold ${nice(pkg)} back` : `Pause updates for ${app ?? 'this app'}`} size="sm">
      <p className="text-[13px] text-ink-2">{pkg ? `Unit7 keeps ${nice(pkg)} where it is and updates everything else as usual.` : 'Nothing updates for this app until then. Security fixes wait too, so keep it short.'}</p>
      <div role="radiogroup" aria-label="How long" className="mt-4 grid grid-cols-2 gap-2">
        {opts.map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={pick === v} onClick={() => setPick(v)}
            className={cx('rounded-[14px] border px-3 py-2.5 text-left text-[13px] font-medium transition', pick === v ? 'border-blue bg-blue-soft text-ink' : 'border-line text-ink-2 hover:border-line-strong')}>{l}</button>
        ))}
      </div>
      {pick === 'date' && <label className="mt-3 block text-[12.5px] text-muted">Until<Input type="date" value={date} min={plusDays(1)} onChange={(e) => setDate(e.target.value)} className="mt-1 h-10 px-3" /></label>}
      <label className="mt-3 block text-[12.5px] text-muted">Why, in a few words (optional)<Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={pkg ? 'e.g. waiting for the payment library' : 'e.g. launch week'} className="mt-1 h-10 px-3" /></label>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="dark" icon={<PauseCircle size={15} />} loading={busy} onClick={save}>{pkg ? 'Hold it' : 'Pause updates'}</Button>
      </div>
    </Modal>
  );
}

// --- a major version: what changes, whether it was tried, and the two choices ---------------------------------------------------
export function MajorCard({ p, batch, notes, onRelease, onHold, busy }: { p: Pick<Planned, 'title' | 'items' | 'summary'>; batch?: Batch | null; notes?: string[]; onRelease: () => void; onHold: () => void; busy?: boolean }) {
  const it = p.items[0]!;
  const bullets = (notes?.length ? notes : batch?.notes?.[it.name]) ?? [];
  const tried = batch?.tests?.status === 'passed' && batch.steps.some((s) => s.key === 'check' && s.state === 'done');
  return (
    <article className="relative overflow-hidden rounded-[22px] border border-line bg-surface p-4">
      <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 size-32 rounded-full bg-[radial-gradient(circle,var(--blue-soft),transparent_70%)]" />
      <div className="relative flex items-start gap-3">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-[14px] bg-ink text-[13px] font-bold tabular text-bg">{major(it.to)}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15.5px] font-semibold tracking-[-0.01em] text-ink">{nice(it.name)} {major(it.from)} → {major(it.to)}</h3>
          <p className="text-[12px] text-muted">A new major version · {it.from} → {it.to}</p>
        </div>
        <Badge tone="warn">Major</Badge>
      </div>
      <ul className="relative mt-3 space-y-1.5">
        {(bullets.length ? bullets : p.summary).slice(0, 3).map((l) => <li key={l} className="flex items-start gap-2 text-[13px] leading-snug text-ink-2"><span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-blue" />{l}</li>)}
      </ul>
      <p className={cx('relative mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium', tried ? 'bg-ok/12 text-ok' : 'bg-raised text-muted')}>
        <StatusMark state={tried ? 'ok' : 'off'} size={14} label={tried ? 'Tested' : 'Not tried yet'} />{tried ? 'Tests passed on staging' : 'Not tried yet: Release tests it on a copy first'}
      </p>
      <div className="relative mt-3.5 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<Rocket size={14} />} loading={busy} onClick={onRelease}>Release</Button>
        <Button size="sm" variant="secondary" icon={<CalendarClock size={14} />} onClick={onHold}>Hold until…</Button>
      </div>
    </article>
  );
}

// --- the pop-up -----------------------------------------------------------------------------------------------------------
const STATUS: Record<Batch['status'], { word: string; tone: 'ok' | 'bad' | 'warn' | 'info' | 'neutral' }> = {
  planned: { word: 'Ready to start', tone: 'info' }, running: { word: 'Updating', tone: 'info' }, waiting: { word: 'Ready for you', tone: 'info' },
  released: { word: 'Live', tone: 'ok' }, held: { word: 'Held back', tone: 'bad' }, rolled_back: { word: 'Rolled back', tone: 'bad' }, failed: { word: 'Held back', tone: 'bad' }, up_to_date: { word: 'Up to date', tone: 'ok' },
};
export function StatusBadge({ s, down }: { s: Batch['status']; down?: number | null }) {
  const x = STATUS[s];
  return <Badge tone={x.tone}>{x.word}{s === 'released' && down !== null && down !== undefined ? ` · ${Math.round(down)} s down` : ''}</Badge>;
}

export function BatchModal({ open, onClose, serviceId, app, planned, batchId, onChange }: { open: boolean; onClose: () => void; serviceId: string; app: string; planned?: Planned | null; batchId?: string | null; onChange?: () => void }) {
  const [id, setId] = useState<string | null | undefined>(batchId);
  const [b, setB] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false);
  const [hold, setHold] = useState<{ pkg?: string } | null>(null);
  useEffect(() => { if (open) { setId(batchId); setB(null); } }, [open, batchId]);
  const load = useCallback(async () => { if (!id) return; const r = await runTool('fresh.batch', { batch: id }).catch(() => null); if (r?.status === 'ok') setB(r.output as Batch); }, [id]);
  useEffect(() => { if (open) void load(); }, [open, load]);
  // a batch that starts while this is open (Release on a planned one): follow it
  useEffect(() => onLive((e) => { const d = e.data as { batch?: string; serviceId?: string } | undefined; if (open && !id && e.type === 'fresh.step' && d?.serviceId === serviceId && d.batch) setId(d.batch); }), [open, id, serviceId]);
  const steps = useLiveSteps(b, load);
  const view = b ? { ...b, steps: steps ?? b.steps } : null;
  const title = view?.title ?? planned?.title ?? 'Updates';
  const items = view?.items ?? planned?.items ?? [];
  const summary = view?.summary?.length ? view.summary : planned?.summary ?? [];
  const isMajor = (view?.kind ?? planned?.kind) === 'major';
  const release = async () => {
    setBusy(true);
    const r = view && !ended(view.status) ? await act('fresh.release', { serviceId, batch: view.id }, { success: 'Released' }) : await act('fresh.run', { serviceId, batch: planned?.key ?? 'weekly' }, { success: 'Done' });
    setBusy(false); onChange?.(); void load();
    return r;
  };
  const canRelease = !view || view.status === 'waiting' || view.status === 'planned';
  return (
    <Modal open={open} onClose={onClose} size="xl" title={<span className="flex flex-wrap items-center gap-2">{isMajor ? `${nice(items[0]?.name ?? '')} ${major(items[0]?.from ?? '')} → ${major(items[0]?.to ?? '')}` : `${title}`}<span className="text-[13px] font-normal text-muted">for {app}</span>{view && <StatusBadge s={view.status} down={view.downSeconds} />}</span>}>
      <div className="space-y-5">
        {id && !view ? <Skeleton className="h-24 rounded-[18px]" /> : view ? <FreshTimeline steps={view.steps} deploymentId={view.deploymentId} /> : (
          // not started yet: on a phone, the eight steps as one calm row
          <><FreshTimeline steps={[]} className="max-sm:hidden" /><FreshTimeline steps={[]} compact className="sm:hidden" /></>
        )}
        {view?.why && (
          <div className="flex flex-wrap items-center gap-3 rounded-[16px] bg-bad/8 px-4 py-3 text-[13px] text-bad animate-rise">
            <span className="min-w-0 flex-1"><span className="font-semibold">{view.status === 'rolled_back' ? 'Rolled back by itself.' : 'Held back.'}</span>{view.status === 'rolled_back' ? ' The version before is live again.' : ' Nothing changed on the live app.'}{view.revertPr ? ` Unit7 opened a pull request taking it back out${view.revertPr.merged ? ', and merged it' : ''}.` : ''}</span>
            <AskButton label="Ask Unit7 why" prompt={`The updates "${title}" for ${app} were held back: ${view.why}. Tell me in plain words what happened and what I can do.`} />
          </div>
        )}
        <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
          <div className="space-y-4">
            {isMajor && items[0] ? <MajorCard p={{ title, items, summary }} batch={view} notes={view?.notes?.[items[0].name]} busy={busy} onRelease={() => void release()} onHold={() => setHold({ pkg: items[0]!.name })} /> : <Changes lines={summary} />}
            <Security items={items} />
            {view?.pr && <a href={view.pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-blue-text hover:underline"><GitPullRequest size={14} aria-hidden />Pull request #{view.pr.number}<ArrowUpRight size={12} aria-hidden /></a>}
          </div>
          <div className="min-w-0">
            {items.length > 0 && <><h3 className="text-[13px] font-semibold text-ink">{items.length} librar{items.length === 1 ? 'y' : 'ies'}</h3><ul className="mt-1 divide-y divide-line">{items.map((i) => <Library key={`${i.eco}:${i.name}`} i={i} onHold={canRelease ? (pkg) => setHold({ pkg }) : undefined} />)}</ul></>}
          </div>
        </div>
        {view && <Advanced b={view} />}
        {!isMajor && canRelease && (
          <Footer accept={view?.accept ?? planned?.accept}>
            <Button variant="secondary" icon={<CalendarClock size={15} />} onClick={() => setHold({})}>Pause this app…</Button>
            <Button variant="primary" icon={<Rocket size={15} />} loading={busy || view?.status === 'running'} onClick={() => void release()}>{view?.status === 'waiting' && view.tests?.status === 'passed' ? 'Release' : 'Test and release'}</Button>
          </Footer>
        )}
      </div>
      <HoldDialog open={!!hold} onClose={() => setHold(null)} serviceId={serviceId} pkg={hold?.pkg} app={app} onDone={() => { onChange?.(); if (hold?.pkg && isMajor) onClose(); }} />
    </Modal>
  );
}

function Footer({ accept, children }: { accept?: { auto: boolean; why: string }; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
      <p className="min-w-[200px] flex-1 text-[12.5px] text-muted">{accept?.why ?? 'Release tests it on a copy first, then ships it with zero downtime.'}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
