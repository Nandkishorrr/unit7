// D4 on the app page, for an app on several servers: one amber note when the servers don't all run with the current
// settings ("Bring them together"), and one quiet line for HTTPS and restarts (details on hover). "Buy a server" lives
// in the add-a-server pop-up: plans sized like the main server, bought only by a person (who approves the price).
import { useState } from 'react';
import { Lock, RefreshCcw, ShoppingCart } from 'lucide-react';
import { act, Button, HoldButton, HoverCard, Skeleton, StatusMark, cx } from '../../ui';
import { useTool } from '../care/data';

interface Care {
  settings: { same: boolean; differs: string[]; unknown: string[]; words?: string };
  certs: { shared: boolean; how: string; words: string };
  restarts: { serverId: string; name: string; window: string | null; needsRestart: boolean | null; lastRestart: string | null; lastResult: string | null; waits?: string }[];
  oneAtATime: string;
}

export function CareNotes({ serviceId, className }: { serviceId: string; className?: string }) {
  const { data, reload } = useTool<Care>('fleet.care', { serviceId });
  const [busy, setBusy] = useState(false);
  if (!data) return <Skeleton className={cx('h-10 rounded-[16px]', className)} />;
  const sync = async () => { setBusy(true); await act('fleet.sync_settings', { serviceId }, { success: 'Every server runs with the current settings', undo: false }); setBusy(false); void reload(); };
  const windows = data.restarts.filter((r) => r.window);
  return (
    <div className={cx('space-y-2', className)}>
      {!data.settings.same && data.settings.differs.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-[18px] bg-warn/10 px-4 py-3">
          <StatusMark state="warn" size={18} label="Needs a look" />
          <p className="min-w-0 flex-1 text-[13px] text-ink"><span className="font-medium">Not all on the same settings.</span> <span className="text-ink-2">{data.settings.words}. Each server out of rotation in turn, so nobody notices.</span></p>
          <Button size="sm" variant="dark" icon={<RefreshCcw size={13} />} loading={busy} onClick={() => void sync()}>Bring them together</Button>
        </div>
      )}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
        <HoverCard content={<p className="max-w-[280px] text-[12.5px] text-ink-2">{data.certs.words}</p>}>
          <span tabIndex={0} className="inline-flex cursor-help items-center gap-1.5"><Lock size={13} aria-hidden />One HTTPS certificate on every server</span>
        </HoverCard>
        <HoverCard content={
          <div className="w-[260px] text-[12.5px] text-ink-2">
            <p>{data.oneAtATime}</p>
            <ul className="mt-2 space-y-1">{data.restarts.map((r) => <li key={r.serverId} className="flex justify-between gap-3"><span className="truncate font-medium text-ink">{r.name}</span><span className="text-right">{r.waits ?? r.window ?? 'No restart window'}</span></li>)}</ul>
          </div>}>
          <span tabIndex={0} className="inline-flex cursor-help items-center gap-1.5"><RefreshCcw size={13} aria-hidden />Restarts one server at a time{windows.length ? ` · ${windows.length} window${windows.length === 1 ? '' : 's'} set` : ''}</span>
        </HoverCard>
      </p>
    </div>
  );
}

interface Offer { provider: 'hetzner' | 'hostinger'; accountId: string; plan: string; label: string; cores: number; memoryGb: number; diskGb: number; monthly: number | null; currency: string; location: string; where: string }
interface Offers { offers: Offer[]; hostinger: { accountId: string; name: string }[]; note: string; next?: string; problems?: string[] }
const money = (n: number | null, c: string) => (n === null ? 'price unknown' : new Intl.NumberFormat(undefined, { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(n));

// "Buy one": the cheapest plans at least as big as the main server; a person holds to buy (then approves the price)
export function BuyServer({ serviceId, name, onBought }: { serviceId: string; name: string; onBought: () => void }) {
  const { data } = useTool<Offers>('fleet.server_offers', { serviceId });
  const [pick, setPick] = useState<number>(0);
  if (!data) return <Skeleton className="mt-2 h-[88px] rounded-[18px]" />;
  if (!data.offers.length) return <p className="mt-2 rounded-[16px] bg-raised px-4 py-3 text-[12.5px] text-ink-2">{data.hostinger.length ? 'Buy a VPS in Hostinger, then it shows up on Servers to add here.' : data.next}</p>;
  const o = data.offers[pick] ?? data.offers[0]!;
  const buy = () => void act('fleet.buy_server', { serviceId, provider: o.provider, accountId: o.accountId, plan: o.plan, location: o.location }, { success: `Bought a server for ${name}: Unit7 prepares it and adds it`, undo: false }).then(onBought);
  return (
    <div className="mt-2">
      <div role="radiogroup" aria-label="Plan" className="grid gap-2 sm:grid-cols-2">
        {data.offers.map((x, k) => (
          <button key={`${x.plan}-${x.location}`} type="button" role="radio" aria-checked={k === pick} onClick={() => setPick(k)}
            className={cx('flex flex-col gap-0.5 rounded-[18px] border p-3 text-left transition', k === pick ? 'border-blue bg-blue-soft' : 'border-line hover:border-line-strong')}>
            <span className="flex items-baseline justify-between gap-2"><span className="truncate text-[13.5px] font-medium text-ink">{x.label}</span><span className="tabular shrink-0 text-[13px] font-semibold text-ink">{money(x.monthly, x.currency)}<span className="text-[11px] font-normal text-muted">/mo</span></span></span>
            <span className="text-[12px] text-muted">Hetzner · {x.where} · {x.diskGb} GB</span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted">{data.note}</p>
        <HoverCard content={<p className="max-w-[240px] text-[12.5px] text-ink-2">It costs {money(o.monthly, o.currency)} a month until you delete it at Hetzner. You confirm the purchase on the next step.</p>}>
          <HoldButton size="md" icon={<ShoppingCart size={14} />} className="border border-line-strong bg-surface text-ink hover:bg-raised" fillClassName="bg-blue/20" onConfirm={buy}>Buy and add it</HoldButton>
        </HoverCard>
      </div>
    </div>
  );
}
