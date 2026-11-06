// A first server, bought from inside Unit7: the plans from the accounts connected, the price in plain sight, a press held to
// buy. A person then approves the price, and Unit7 connects the server and prepares it. Nothing here pays by itself.
import { useState } from 'react';
import { ShoppingCart } from 'lucide-react';
import { runTool, type ToolResult } from '../../lib/api';
import { openSignIn } from '../../lib/actions';
import { navigate } from '../../lib/router';
import { tidy } from '../../lib/words';
import { Button, Dialog, HoldButton, Skeleton, cx, toast } from '../../ui';
import { useTool } from '../care/data';

interface Offer { provider: 'hetzner' | 'hostinger'; accountId: string; plan: string; label: string; cores: number; memoryGb: number; diskGb: number; monthly: number | null; currency: string; location: string; where: string; itemId?: string; templateId?: number; dataCenterId?: number }
interface Offers { offers: Offer[]; note: string; next?: string; problems?: string[] }
const money = (n: number | null, c: string) => (n === null ? 'price unknown' : new Intl.NumberFormat(undefined, { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(n));
const who = (o: Offer) => (o.provider === 'hetzner' ? 'Hetzner' : 'Hostinger');

function Plans({ onClose }: { onClose: () => void }) {
  const { data, error } = useTool<Offers>('server.offers', {});
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  if (error) return <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-ink-2">{tidy(error)}</p>;
  if (!data) return <Skeleton className="h-[120px] rounded-[18px]" />;
  if (!data.offers.length) return (
    <div className="space-y-3">
      <p className="text-[13.5px] text-muted">{data.problems?.length ? 'Your provider didn’t answer with any plans. Try again in a minute.' : data.next ?? 'No plans to show right now.'}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => openSignIn('hostinger', 'Hostinger')}>Connect Hostinger</Button>
        <Button onClick={() => { onClose(); navigate('/connections'); }}>Connect Hetzner</Button>
      </div>
    </div>
  );
  const o = data.offers[pick] ?? data.offers[0]!;
  const buy = async () => {
    setBusy(true);
    const r: ToolResult = await runTool('server.buy', { provider: o.provider, accountId: o.accountId, ...(o.provider === 'hetzner' ? { plan: o.plan, location: o.location } : { item: o.itemId, templateId: o.templateId, dataCenterId: o.dataCenterId }) })
      .catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    setBusy(false);
    if (r.status === 'approval_required') { toast('info', 'One last yes', 'Confirm the price on Approvals. Unit7 then buys it, connects it and prepares it.'); onClose(); navigate('/approvals'); }
    else if (r.status === 'ok') { toast('ok', `Bought ${r.output.bought}`, r.output.next ?? r.output.why); onClose(); }
    else toast('bad', 'That didn’t work', r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : undefined);
  };
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Plan" className="grid gap-2 sm:grid-cols-2">
        {data.offers.map((x, k) => (
          <button key={`${x.provider}-${x.plan}-${x.location}`} type="button" role="radio" aria-checked={k === pick} onClick={() => setPick(k)}
            className={cx('flex flex-col gap-0.5 rounded-[18px] border p-3 text-left transition', k === pick ? 'border-blue bg-blue-soft' : 'border-line hover:border-line-strong')}>
            <span className="flex items-baseline justify-between gap-2"><span className="truncate text-[13.5px] font-medium text-ink">{x.label}</span><span className="tabular shrink-0 text-[13px] font-semibold text-ink">{money(x.monthly, x.currency)}<span className="text-[11px] font-normal text-muted">/mo</span></span></span>
            <span className="text-[12px] text-muted">{who(x)} · {x.where} · {x.diskGb} GB</span>
          </button>
        ))}
      </div>
      <p className="text-[12.5px] text-muted">It costs {money(o.monthly, o.currency)} a month until you delete it at {who(o)}. {data.note}</p>
      <div className="flex justify-end"><HoldButton size="md" loading={busy} icon={<ShoppingCart size={14} />} onConfirm={buy}>Buy this server</HoldButton></div>
    </div>
  );
}

export function BuyServerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onClose={onClose} title="Buy a server" wide>{open && <Plans onClose={onClose} />}</Dialog>;
}
