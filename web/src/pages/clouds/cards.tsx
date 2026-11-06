// Chat cards for the big clouds' actions: a DNS record removed (with Undo), a redeploy / restart / rollback, a spending
// alert set, spending by day (with "Stop the runaway thing" when it jumped) and the stops carried out.
import { useState } from 'react';
import { BellRing, Check, Flame, History, OctagonPause, RefreshCw, RotateCcw, Trash2, Undo2, Wallet, X } from 'lucide-react';
import { act, Button } from '../../ui';
import { tidy } from '../../lib/words';
import { BrandLogo } from '../../brand/BrandLogo';
import { Frame, Pill } from '../chat/cards/kit';
import { money, SpendSpark, StopPlanModal, type Spend } from './money';

type P = { tool: string; input: any; output: any };

export function CloudChatCard({ tool, input, output: o }: P) {
  if (tool === 'domain.remove_record') return <RemovedCard o={o} />;
  if (tool === 'cloud.redeploy') return <RedeployCard o={o} />;
  if (tool === 'cloud.budget_set') return <AlertSetCard o={o} />;
  if (tool === 'cloud.spend') return <SpendCard accountId={input?.accountId} o={o as Spend} />;
  if (tool === 'cloud.stop_runaway') return <StoppedCard o={o} />;
  return null;
}

function UndoButton({ changeId, label = 'Undo' }: { changeId: string; label?: string }) {
  const [done, setDone] = useState(false);
  return done ? <Pill tone="ok">Undone</Pill> : <Button size="sm" variant="soft" icon={<Undo2 size={13} />} onClick={async () => { if (await act('change.undo', { changeId }, { success: 'Put back', undo: false })) setDone(true); }}>{label}</Button>;
}

function RemovedCard({ o }: { o: { removed: string[]; at: string; takeoverCleared?: boolean; changeId: string } }) {
  return (
    <Frame icon={<Trash2 size={16} />} tone="soft" title="DNS record removed" sub={`At ${o.at}`} right={<UndoButton changeId={o.changeId} />}>
      <ul className="space-y-1">{o.removed.map((r) => <li key={r} className="break-all font-mono text-[12px] text-ink-2">{r}</li>)}</ul>
      {o.takeoverCleared && <p className="mt-2 text-[12.5px] text-ok">Nobody can take this name over anymore.</p>}
    </Frame>
  );
}

const MODE_ICON = { redeploy: RefreshCw, restart: RotateCcw, rollback: History } as const;
function RedeployCard({ o }: { o: { name: string; provider: string; mode: keyof typeof MODE_ICON; said: string; done?: boolean; undo?: { tool: string; input: object } } }) {
  const I = MODE_ICON[o.mode] ?? RefreshCw;
  return (
    <Frame icon={<I size={16} />} tone={o.done === false ? 'blue' : 'ok'} title={o.name} sub={tidy(o.said)}
      right={<span className="flex items-center gap-2"><BrandLogo id={o.provider} size={18} />{o.undo && <Button size="sm" variant="ghost" icon={<Undo2 size={13} />} onClick={() => act(o.undo!.tool, o.undo!.input, { success: 'Done', undo: false })}>Undo</Button>}</span>} />
  );
}

function AlertSetCard({ o }: { o: { account: string; budget: { amount: number; currency: string; alertsAt: number[] }; emails: string; manageUrl?: string } }) {
  return (
    <Frame icon={<BellRing size={16} />} tone="ok" title={`Spending alert on ${o.account}`} sub={`${money(o.budget.amount, o.budget.currency)} a month · emails at ${o.budget.alertsAt.join(', ')}% · to ${o.emails}`}
      right={o.manageUrl ? <a href={o.manageUrl} target="_blank" rel="noopener" className="text-[12.5px] font-medium text-blue-text hover:underline">Open billing</a> : undefined} />
  );
}

function SpendCard({ accountId, o }: { accountId?: string; o: Spend }) {
  const [plan, setPlan] = useState(false);
  const hot = !!o.spike?.spike || o.over?.length > 0;
  return (
    <Frame icon={hot ? <Flame size={16} /> : <Wallet size={16} />} tone={hot ? 'bad' : 'soft'} title={`${o.account}: spending by day`}
      right={hot ? <Pill tone="bad" glow>Jumped</Pill> : o.spike ? <Pill tone="ok">Normal</Pill> : undefined}>
      {o.days.length ? (
        <div className="flex flex-wrap items-end gap-4">
          <SpendSpark s={o} />
          {o.spike && <p className="text-[12.5px] text-muted">Usually {money(o.spike.normal, o.currency)} a day · yesterday {money(o.spike.latest, o.currency)}</p>}
        </div>
      ) : <p className="text-[12.5px] text-muted">{o.note ?? 'No daily spending for this account.'}</p>}
      {hot && accountId && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[13px]">If nothing changes: about <b className="font-semibold">{money(o.doNothing24h ?? 0, o.currency)}</b> in the next 24 hours.</p>
          <Button size="sm" variant="dark" icon={<OctagonPause size={14} />} onClick={() => setPlan(true)}>Stop the runaway thing</Button>
          <StopPlanModal open={plan} onClose={() => setPlan(false)} accountId={accountId} initial={o} />
        </div>
      )}
    </Frame>
  );
}

function StoppedCard({ o }: { o: { account: string; stopped: { name: string; what: string; changeId: string }[]; failed: { name: string; why: string }[] } }) {
  return (
    <Frame icon={<OctagonPause size={16} />} tone={o.failed.length && !o.stopped.length ? 'bad' : 'ok'} title={`Stopped on ${o.account}`} sub="Nothing was deleted">
      <ul className="space-y-1.5">
        {o.stopped.map((s) => <li key={s.changeId} className="flex items-center gap-2 text-[13px]"><Check size={14} className="shrink-0 text-ok" aria-hidden /><span className="min-w-0 flex-1 truncate">{s.name}</span><UndoButton changeId={s.changeId} label="Start again" /></li>)}
        {o.failed.map((s) => <li key={s.name} className="flex items-start gap-2 text-[13px]"><X size={14} className="mt-0.5 shrink-0 text-bad" aria-hidden /><span>{s.name}: {tidy(s.why)}</span></li>)}
      </ul>
    </Frame>
  );
}
