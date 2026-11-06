// Money on the big clouds, as small calm pieces other pages mount: the "Set a spending alert" pop-up (50/90/100% of an
// amount, one click), Google's billing-export steps, a quiet spend-by-day strip, the "Spending jumped" banner, and the
// "Stop the runaway thing" plan pop-up (a person ticks what to stop, types the account's name and holds to confirm;
// nothing is ever deleted and each stop has Undo in Activity).
import { useEffect, useMemo, useState } from 'react';
import { BellPlus, Check, ExternalLink, Flame, Loader2, OctagonPause, RefreshCw, TrendingUp, X } from 'lucide-react';
import { runTool, useApi, type LiveEvent } from '../../lib/api';
import { tidy } from '../../lib/words';
import { act, Button, HoldButton, Input, Modal, cx, toast } from '../../ui';

export const money = (n: number, currency = 'USD') => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n); } catch { return `${n.toFixed(2)} ${currency}`; } };
const fail = (r: Awaited<ReturnType<typeof runTool>>) => (r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? `Waiting for approval: ${r.why}` : 'That didn’t work.');

// --- a spending alert in one click ----------------------------------------------------------------------------------
export interface AlertTarget { id: string; name: string; provider: string }
// suggested: last month's (or this month's) spend with some room, else $25 for a new account
export const suggestAmount = (spent?: number | null) => (spent && spent > 0 ? Math.max(10, Math.ceil((spent * 1.3) / 5) * 5) : 25);

export function BudgetAlertButton({ account, currency, spent, onDone, size = 'sm' }: { account: AlertTarget; currency?: string; spent?: number | null; onDone?: () => void; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant="soft" icon={<BellPlus size={14} />} onClick={() => setOpen(true)}>Set a spending alert</Button>
      <BudgetAlertModal open={open} onClose={() => setOpen(false)} account={account} currency={currency} spent={spent} onDone={onDone} />
    </>
  );
}

const LEVELS = [50, 75, 90, 100, 120];
export function BudgetAlertModal({ open, onClose, account, currency = 'USD', spent, onDone }: { open: boolean; onClose: () => void; account: AlertTarget; currency?: string; spent?: number | null; onDone?: () => void }) {
  const [amount, setAmount] = useState(String(suggestAmount(spent)));
  const [at, setAt] = useState<number[]>([50, 90, 100]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setAmount(String(suggestAmount(spent))); setAt([50, 90, 100]); setEmail(''); } }, [open, spent]);
  const google = account.provider === 'gcp' || account.provider === 'firebase';
  const n = Number(amount);
  const ok = Number.isFinite(n) && n > 0 && at.length > 0;
  const save = async () => {
    setBusy(true);
    const r = await act('cloud.budget_set', { accountId: account.id, amount: n, ...(!google && { currency }), thresholds: at, ...(email.trim() && { email: email.trim() }) }, { success: `Spending alert set on ${account.name}`, undo: false });
    setBusy(false);
    if (r) { onClose(); onDone?.(); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Set a spending alert" size="sm">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ok && !busy) void save(); }}>
        <p className="text-[13.5px] text-ink-2">An email when {account.name} has spent part of a monthly amount. It only warns: nothing is stopped.</p>
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">Each month, up to</span>
          <span className="flex items-center gap-2">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} aria-describedby="alert-cur" className="max-w-[160px] text-[18px] font-semibold tabular" />
            <span id="alert-cur" className="text-[13px] text-muted">{google ? 'in your billing account’s currency' : currency}</span>
          </span>
        </label>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Email me at</legend>
          <div className="flex flex-wrap gap-1.5">
            {LEVELS.map((p) => {
              const on = at.includes(p);
              return <button key={p} type="button" aria-pressed={on} onClick={() => setAt((x) => (on ? x.filter((y) => y !== p) : [...x, p].sort((a, b) => a - b).slice(0, 5)))}
                className={cx('inline-flex h-8 items-center gap-1 rounded-full px-3 text-[13px] font-medium transition', on ? 'bg-ink text-surface' : 'bg-raised text-ink-2 hover:bg-sunken')}>{on && <Check size={12} aria-hidden />}{p}%</button>;
            })}
          </div>
          {ok && <p className="mt-1.5 text-[12.5px] text-muted tabular">{at.map((p) => (google ? String(Math.round(n * p) / 100) : money((n * p) / 100, currency))).join(' · ')}</p>}
        </fieldset>
        {google ? <p className="rounded-[14px] bg-raised px-3 py-2.5 text-[12.5px] text-ink-2">Google emails your billing account’s admins.</p> : (
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">Send the emails to</span>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you (leave empty)" autoComplete="email" />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Not now</Button>
          <Button type="submit" variant="primary" icon={<BellPlus size={14} />} loading={busy} disabled={!ok}>Set the alert</Button>
        </div>
      </form>
    </Modal>
  );
}

// --- Google: the billing export ---------------------------------------------------------------------------------------
export function ExportSteps({ accountId, steps, link, onFound }: { accountId: string; steps: string[]; link: string; onFound?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(false);
  const check = async () => {
    setBusy(true);
    const r = await runTool('cloud.billing_export', { accountId }).catch(() => undefined);
    setBusy(false);
    if (r?.status === 'ok' && (r.output as { found: boolean }).found) { toast('ok', 'Found your billing export', 'Spending shows here from now on.'); onFound?.(); }
    else { setLeft(true); toast('info', 'Not there yet', 'Google can take up to a day to create it.'); }
  };
  return (
    <div className="rounded-[16px] border border-dashed border-line-strong p-3.5">
      <p className="text-[13px] font-medium text-ink">See Google spending here</p>
      <p className="mt-0.5 text-[12.5px] text-muted">Google only shares it through a billing export, which you switch on once:</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-[12.5px] text-ink-2">{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a href={link} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3.5 text-[12.5px] font-medium text-surface transition hover:opacity-90">Open billing export <ExternalLink size={12} /></a>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={busy} onClick={check}>{left ? 'Check again' : 'I’ve done it'}</Button>
      </div>
      <p className="mt-2 text-[11.5px] text-faint">Unit7 reads it at most every 6 hours. Each read costs Google a fraction of a cent.</p>
    </div>
  );
}

// --- spend by day, the spike, and the plan ------------------------------------------------------------------------------
export interface StopStep { id: string; kind: string; ref: string; name: string; what: string; note: string; perDay?: number }
export interface Spend {
  account: string; provider: string; currency: string; days: { day: string; amount: number }[];
  spike: { normal: number; latest: number; runRate: number; worst: number; excess: number; spike: boolean } | null;
  over: { name: string; amount: number; spent: number; currency: string }[];
  culprits: { name: string; normal: number; latest: number; rise: number }[]; steps: StopStep[]; explain: { name: string; why: string }[];
  doNothing24h?: number; extra24h?: number; note?: string;
}

// nine small bars, the last two (yesterday, today so far) brighter; a spike day goes red
export function SpendSpark({ s, className }: { s: Spend; className?: string }) {
  const max = Math.max(...s.days.map((d) => d.amount), 0.01);
  const normal = s.spike?.normal ?? 0;
  return (
    <div className={cx('flex items-end gap-1', className)} role="img" aria-label={`Spend by day for the last ${s.days.length} days: ${s.days.map((d) => money(d.amount, s.currency)).join(', ')}`}>
      {s.days.map((d, i) => {
        const hot = normal > 0 ? d.amount >= normal * 3 && d.amount - normal >= 5 : false;
        return <span key={d.day} title={`${d.day}: ${money(d.amount, s.currency)}`} className={cx('block w-2.5 rounded-full transition-[height] duration-500 motion-reduce:transition-none', hot ? 'bg-bad-solid' : i >= s.days.length - 2 ? 'bg-blue' : 'bg-line-strong')}
          style={{ height: `${Math.max(6, (d.amount / max) * 36)}px` }} />;
      })}
    </div>
  );
}

// "See it by day": asked only when a person wants it (AWS charges a cent per read; Unit7 keeps it 12 hours)
export function SpendByDay({ accountId }: { accountId: string }) {
  const [s, setS] = useState<Spend | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(false);
  const alerted = !!useSpikeEvent(accountId); // the banner above already says it
  const load = async () => {
    setBusy(true); setErr(null);
    const r = await runTool('cloud.spend', { accountId }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    setBusy(false);
    if (r.status === 'ok') setS(r.output as Spend); else setErr(fail(r));
  };
  if (!s) return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" icon={<TrendingUp size={13} />} loading={busy} onClick={load}>See it by day</Button>
      {err && <span className="text-[12px] text-muted">{tidy(err)}</span>}
    </div>
  );
  if (!s.days.length) return <p className="text-[12.5px] text-muted">{s.note ?? 'Spending by day isn’t available for this account.'}</p>;
  const hot = !!s.spike?.spike || s.over.length > 0;
  return (
    <div className="space-y-2">
      <div className="flex items-end gap-4">
        <SpendSpark s={s} />
        <p className="text-[12.5px] text-muted">{s.spike ? <>Usually about <b className="font-semibold text-ink-2">{money(s.spike.normal, s.currency)}</b> a day; yesterday {money(s.spike.latest, s.currency)}.</> : null}</p>
      </div>
      {hot && !alerted && <SpikeLine s={s} onPlan={() => setPlan(true)} />}
      <StopPlanModal open={plan} onClose={() => setPlan(false)} accountId={accountId} initial={s} />
    </div>
  );
}

function SpikeLine({ s, onPlan }: { s: Spend; onPlan: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[16px] bg-bad/8 px-3.5 py-3">
      <Flame size={16} className="shrink-0 text-bad" aria-hidden />
      <p className="min-w-0 flex-1 basis-[200px] text-[13px] text-ink">
        {s.spike?.spike ? <><b className="font-semibold">Spending jumped</b>: about {money(s.spike.worst, s.currency)} a day against {money(s.spike.normal, s.currency)} usually.</>
          : <><b className="font-semibold">{s.over[0]!.name}</b> is past 100% ({money(s.over[0]!.spent, s.over[0]!.currency)} of {money(s.over[0]!.amount, s.over[0]!.currency)}).</>}
      </p>
      <Button size="sm" variant="dark" icon={<OctagonPause size={14} />} onClick={onPlan}>Stop the runaway thing</Button>
    </div>
  );
}

// Warden's twice-daily look raised "spending jumped" for this account in the last day
function useSpikeEvent(accountId: string) {
  const events = useApi<LiveEvent[]>('/api/events?limit=200', { live: (e) => e.type === 'cost.spike' });
  return useMemo(() => (events.data ?? []).find((e) => e.type === 'cost.spike' && e.resource === accountId && Date.now() - Date.parse(e.created_at) < 86400_000), [events.data, accountId]);
}
// the banner for it, with the plan
export function SpikeBanner({ accountId }: { accountId: string }) {
  const [plan, setPlan] = useState(false);
  const hit = useSpikeEvent(accountId);
  if (!hit) return null;
  return (
    <>
      <div className="animate-rise flex flex-wrap items-center gap-3 rounded-[16px] bg-bad/8 px-3.5 py-3">
        <Flame size={16} className="shrink-0 text-bad" aria-hidden />
        <p className="min-w-0 flex-1 basis-[200px] text-[13px] text-ink">{tidy(hit.message.replace(/ Unit7 has a plan.*$/, ''))}</p>
        <Button size="sm" variant="dark" icon={<OctagonPause size={14} />} onClick={() => setPlan(true)}>Stop the runaway thing</Button>
      </div>
      <StopPlanModal open={plan} onClose={() => setPlan(false)} accountId={accountId} />
    </>
  );
}

// the plan: what to stop (all ticked), what each does, what doing nothing costs; the account's name and a hold to confirm
export function StopPlanModal({ open, onClose, accountId, initial }: { open: boolean; onClose: () => void; accountId: string; initial?: Spend }) {
  const [s, setS] = useState<Spend | null>(initial ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState('');
  const [state, setState] = useState<{ busy?: boolean; error?: string; done?: { stopped: { name: string }[]; failed: { name: string; why: string }[] } }>({});
  useEffect(() => {
    if (!open) return;
    setTyped(''); setState({});
    if (initial) { setS(initial); setPick(new Set(initial.steps.map((x) => x.id))); return; }
    let live = true;
    setS(null); setErr(null);
    runTool('cloud.spend', { accountId }).then((r) => { if (!live) return; if (r.status === 'ok') { const v = r.output as Spend; setS(v); setPick(new Set(v.steps.map((x) => x.id))); } else setErr(fail(r)); }, (e: Error) => live && setErr(e.message));
    return () => { live = false; };
  }, [open, accountId, initial]);
  const ready = !!s && pick.size > 0 && typed.trim().toLowerCase() === s.account.toLowerCase() && !state.busy;
  const go = async () => {
    setState({ busy: true });
    const r = await runTool('cloud.stop_runaway', { accountId, steps: [...pick], confirmName: typed.trim() }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    if (r.status === 'ok') { setState({ done: r.output as never }); toast('ok', 'Stopped', 'Each one starts again with Undo in Activity.'); }
    else setState({ error: fail(r) });
  };
  return (
    <Modal open={open} onClose={onClose} title={s ? `Stop the runaway thing on ${s.account}` : 'Stop the runaway thing'} size="lg">
      <div className="space-y-4">
        {!s && !err && <div className="space-y-3" aria-busy="true" aria-label="Working out what’s running away"><span className="skeleton block h-7 w-2/3" /><span className="skeleton block h-28" /></div>}
        {err && <p role="alert" className="rounded-[16px] bg-bad/8 px-4 py-3 text-[13px] text-ink-2">{tidy(err)}</p>}
        {s && state.done ? (
          <div className="space-y-3">
            {state.done.stopped.map((x) => <p key={x.name} className="flex items-center gap-2 text-[13.5px]"><Check size={15} className="text-ok" aria-hidden />{x.name} stopped</p>)}
            {state.done.failed.map((x) => <p key={x.name} className="flex items-start gap-2 text-[13.5px]"><X size={15} className="mt-0.5 text-bad" aria-hidden /><span>{x.name}: {tidy(x.why)}</span></p>)}
            <p className="text-[12.5px] text-muted">Each one can be started again with Undo in Activity. Nothing was deleted.</p>
            <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
          </div>
        ) : s && (
          <>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <p><span className="block text-[12px] text-muted">If nothing changes, the next 24 hours</span><span className="text-[28px] font-semibold leading-none tracking-[-0.03em] tabular">{money(s.doNothing24h ?? 0, s.currency)}</span></p>
              {!!s.extra24h && <p><span className="block text-[12px] text-muted">More than usual</span><span className="text-[17px] font-semibold text-bad tabular">+{money(s.extra24h, s.currency)}</span></p>}
              {s.days.length > 0 && <SpendSpark s={s} className="ml-auto" />}
            </div>
            {s.culprits.length > 0 && (
              <div>
                <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.06em] text-faint">What rose the most</p>
                <ul className="divide-y divide-line rounded-[16px] border border-line">{s.culprits.map((c) => (
                  <li key={c.name} className="flex items-center gap-3 px-3.5 py-2.5 text-[13px]"><span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="tabular text-muted">{money(c.normal, s.currency)} → <b className="font-semibold text-ink">{money(c.latest, s.currency)}</b> a day</span></li>
                ))}</ul>
              </div>
            )}
            {s.steps.length > 0 ? (
              <fieldset>
                <legend className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.06em] text-faint">The safest stop for each</legend>
                <ul className="space-y-2">{s.steps.map((x) => (
                  <li key={x.id}>
                    <label className="flex cursor-pointer items-start gap-3 rounded-[16px] border border-line p-3 transition hover:bg-raised/60">
                      <input type="checkbox" checked={pick.has(x.id)} onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(x.id); else n.delete(x.id); return n; })} className="mt-0.5 size-4 accent-[var(--bad-solid)]" />
                      <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium">{x.what}: {x.name}</span><span className="mt-0.5 block text-[12.5px] text-muted">{x.note}</span></span>
                    </label>
                  </li>
                ))}</ul>
              </fieldset>
            ) : <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-ink-2">Unit7 found nothing it can stop safely here.</p>}
            {s.explain.length > 0 && <ul className="space-y-1">{s.explain.map((x) => <li key={x.name} className="text-[12.5px] text-muted"><b className="font-medium text-ink-2">{x.name}</b>: {x.why}</li>)}</ul>}
            {s.steps.length > 0 && (
              <form onSubmit={(e) => e.preventDefault()} className="space-y-3 border-t border-line pt-4">
                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium">Type <span className="font-semibold">{s.account}</span> to confirm</span>
                  <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={s.account} autoComplete="off" spellCheck={false} />
                </label>
                {state.error && <p role="alert" className="flex gap-2 rounded-[16px] bg-bad/8 px-4 py-3 text-[13px] text-ink-2"><X size={15} className="mt-0.5 shrink-0 text-bad" />{tidy(state.error)}</p>}
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={onClose}>Not now</Button>
                  <HoldButton icon={state.busy ? <Loader2 size={14} className="animate-spin" /> : <OctagonPause size={14} />} disabled={!ready} onConfirm={go}>{`Stop ${pick.size} thing${pick.size === 1 ? '' : 's'}`}</HoldButton>
                </div>
                <p className="text-[12px] text-faint">Nothing is deleted. Each stop can be started again from Activity.</p>
              </form>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
