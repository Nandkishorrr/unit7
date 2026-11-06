// Start free: for someone new, what each service gives you for $0 and when you'd start paying. Pick what you're building
// and a free stack snaps into place, with a "$0" meter that shows how many users it carries; browse every need (hosting,
// databases, sign-in, email…) with the key limit, a hover card with everything else and its source; put two or three
// side by side. Connect buttons open Unit7's own connect pop-up; self-run tools go to Add to my server.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowRight, ArrowUpRight, ChartColumn, Check, ChevronDown, CreditCard, Database, Globe2, HardDrive, KeyRound, Newspaper, PackagePlus, Plus, Rocket, Send, Server, ShieldCheck, Sparkles } from 'lucide-react';
import { useApi } from '../../lib/api';
import { navigate } from '../../lib/router';
import { Badge, Button, ChipSelect, CountUp, HoverCard, Illustration, Modal, PageHeader, cx, StatusMark } from '../../ui';
import { BrandLogo } from '../../brand/BrandLogo';
import { Menu } from '../kit';
import { CHECKED_WORDS, GOALS, NEEDS, perUser, plan, plansFor, recommend, summarize, toggle, type Goal, type Need, type Pick, type Plan } from './plans';

const ICON: Record<Need, typeof Rocket> = {
  hosting: Rocket, database: Database, auth: KeyRound, email: Send, newsletter: Newspaper, payments: CreditCard, domains: Globe2,
  dns: ShieldCheck, vps: Server, storage: HardDrive, analytics: ChartColumn, monitoring: Activity, ai: Sparkles,
};
const needLabel = (n: Need) => NEEDS.find((x) => x.id === n)!.label;
// a stack slot is small: a short need word over a short name ("Sign-in" over "Supabase", not "Supabase Auth")
const SLOT: Partial<Record<Need, string>> = { email: 'Email', newsletter: 'Newsletter', dns: 'DNS', storage: 'Files', monitoring: 'Errors' };
const slotName = (p: Plan) => p.name.replace(/ (Auth|Registrar|Pages \+ Workers|Web Analytics|Storage|Hosting|Firestore|Redis|Atlas|API|Always Free|e2-micro|VPS|B2)$/, '').replace(/^(Better Auth) \/ Auth\.js$/, '$1');
const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const full = (n: number) => Math.round(n).toLocaleString('en');
// what a $0 stack can hold: free plans, free software, pay-per-sale, and the domain (said as a yearly cost)
const stackable = (p: Plan) => p.free === 'free' || p.free === 'self-host' || p.free === 'per-sale' || p.need === 'domains';
const FREE: Record<Plan['free'], { word: string; tone: 'ok' | 'warn' | 'info' | 'neutral' | 'lime' }> = {
  free: { word: 'Free', tone: 'ok' }, trial: { word: 'Trial', tone: 'warn' }, credit: { word: 'Credit', tone: 'info' },
  none: { word: 'Paid', tone: 'neutral' }, 'self-host': { word: 'Free, self-run', tone: 'ok' }, 'per-sale': { word: 'Per sale', tone: 'info' },
};

interface Conn { id: string; accounts: { pending: string | null }[] }

export function Guide({ onConnect, intro }: { onConnect: (provider: string) => void; intro?: boolean }) {
  const conns = useApi<Conn[]>('/api/connections', { live: (e) => e.type.startsWith('account.') });
  const known = new Map((conns.data ?? []).map((c) => [c.id, c.accounts.some((a) => !a.pending)]));
  const hosts = new Set(useApi<{ id: string }[]>('/api/live/hosts', { live: false }).data?.map((h) => h.id));
  const [goal, setGoal] = useState<Goal>('app');
  const [stack, setStack] = useState<Pick[]>(() => recommend('app').picks);
  const [round, setRound] = useState(0); // a new goal: every logo snaps in again
  const [need, setNeed] = useState<Need>('hosting');
  const browse = useRef<HTMLElement>(null);
  const pickGoal = (g: Goal) => { setGoal(g); setStack(recommend(g).picks); setRound((r) => r + 1); };
  const goTo = (n: Need) => { setNeed(n); browse.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); };
  const ctx: RowCtx = { known, hosts, onConnect, inStack: (p) => stack.some((x) => x.plan === p.id), onToggle: (p) => setStack((s) => toggle(s, p)) };

  return (
    <div className="space-y-9">
      {intro && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14px] text-muted">
          What each service gives you for $0, and when you’d start paying.
          <Checked />
        </p>
      )}

      <section aria-labelledby="g-build" className="space-y-4">
        <h3 id="g-build" className="text-[17px] font-semibold tracking-[-0.025em]">What are you building?</h3>
        <div role="radiogroup" aria-labelledby="g-build" className="flex flex-wrap gap-2">
          {GOALS.map((g) => (
            <button key={g.id} type="button" role="radio" aria-checked={goal === g.id} onClick={() => pickGoal(g.id)}
              className={cx('h-9 rounded-full px-4 text-[13.5px] font-medium transition active:scale-[0.98]',
                goal === g.id ? 'bg-ink text-bg' : 'border border-line-strong bg-surface text-ink-2 hover:border-ink hover:text-ink')}>
              {g.label}
            </button>
          ))}
        </div>
        <Stack stack={stack} round={round} onPick={goTo} onRemove={(p) => setStack((s) => toggle(s, p))} />
      </section>

      <section ref={browse} aria-labelledby="g-browse" className="scroll-mt-4 space-y-4">
        <Browse need={need} setNeed={setNeed} ctx={ctx} />
      </section>

      <p className="border-t border-line pt-4 text-[12px] text-faint">
        “Fits about” is an estimate from one limit and the assumption you see on hover, not a number from the provider. Prices and limits change:
        each card links the page it came from, checked {CHECKED_WORDS}.
      </p>
    </div>
  );
}

const Checked = () => (
  <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-raised px-2.5 text-[12px] font-medium text-ink-2">
    <Check size={12} strokeWidth={3} className="text-ok" aria-hidden />Checked {CHECKED_WORDS} · sources on every card
  </span>
);

// --- the stack: one logo per need, snapping in; the $0 meter beside it ------------------------------------------------
function Stack({ stack, round, onPick, onRemove }: { stack: Pick[]; round: number; onPick: (n: Need) => void; onRemove: (p: Plan) => void }) {
  const s = summarize(stack.map((x) => x.plan));
  return (
    <div className="grid gap-6 rounded-[24px] bg-raised p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
      <div className="min-w-0 space-y-3">
        <p className="text-[12px] font-medium uppercase tracking-[0.06em] text-faint">Your free stack</p>
        <ul className="flex flex-wrap gap-2.5" aria-label="Your free stack">
          {stack.map((x, i) => {
            const p = plan(x.plan)!;
            return (
              <li key={`${round}:${x.plan}`} className="check-pop" style={{ animationDelay: `${i * 70}ms` }}>
                <HoverCard content={(
                  <div className="space-y-2">
                    <p className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint">{needLabel(p.need)}</p>
                    <p className="font-semibold">{p.name}</p>
                    <p className="text-ink-2">{x.why}</p>
                    <p className="text-muted">{p.key}</p>
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" variant="soft" onClick={() => onPick(p.need)}>See others</Button>
                      <Button size="sm" variant="ghost" onClick={() => onRemove(p)}>Take out</Button>
                    </div>
                  </div>
                )}>
                  <button type="button" onClick={() => onPick(p.need)} aria-label={`${needLabel(p.need)}: ${p.name}. ${x.why}`}
                    className="lift flex w-[76px] flex-col sm:w-[88px] items-center gap-1.5 rounded-[18px] bg-surface px-2 pb-2.5 pt-3 text-center shadow-soft outline-none focus-visible:ring-2 focus-visible:ring-blue">
                    <BrandLogo id={p.logo} size={26} title={p.name} />
                    <span className="mt-0.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-faint">{SLOT[p.need] ?? needLabel(p.need)}</span>
                    <span className="w-full truncate text-[12.5px] font-semibold leading-tight">{slotName(p)}</span>
                  </button>
                </HoverCard>
              </li>
            );
          })}
          <li>
            <button type="button" onClick={() => onPick(NEEDS.find((n) => !stack.some((x) => x.need === n.id))?.id ?? 'hosting')}
              className="flex h-full min-h-[96px] w-[76px] flex-col sm:w-[88px] items-center justify-center gap-1.5 rounded-[18px] border-2 border-dashed border-line-strong text-[12px] font-medium text-muted transition hover:border-ink hover:text-ink">
              <Plus size={18} aria-hidden />Add
            </button>
          </li>
        </ul>
      </div>
      <FreeMeter s={s} />
    </div>
  );
}

// "$0/month until about N users": the fill runs (on a 100 → 100K scale) to where the first free plan runs out; past it,
// a hatched stretch is where you'd pay. It fills from empty when it first shows, and moves when the stack changes.
function FreeMeter({ s }: { s: ReturnType<typeof summarize> }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
  const at = s.users === null ? 1 : Math.min(1, Math.max(0.03, (Math.log10(s.users) - 2) / 3));
  const pct = `${(shown ? at : 0) * 100}%`;
  const label = s.users === null ? 'Free, with no user cap we can count' : `Free until about ${full(s.users)} users`;
  return (
    <div className="min-w-0 space-y-3">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[40px] font-semibold leading-none tracking-[-0.04em] tabular">$0</span>
        <span className="text-[14.5px] text-ink-2">/month {s.users === null ? 'with no user cap we can count' : <>until about <b className="font-semibold text-ink"><CountUp key={s.users} value={s.users} format={full} /></b> users</>}</span>
      </p>
      <div>
        <div role="meter" aria-label={label} aria-valuemin={100} aria-valuemax={100000} aria-valuenow={Math.min(100000, s.users ?? 100000)}
          className="relative h-2.5 rounded-full bg-surface">
          {s.users !== null && at < 1 && <span aria-hidden className="absolute inset-y-0 right-0 rounded-r-full" style={{ left: `${at * 100}%`, background: 'repeating-linear-gradient(135deg, var(--line-strong) 0 3px, transparent 3px 7px)' }} />}
          <span aria-hidden className="absolute inset-y-0 left-0 rounded-full bg-lime transition-[width] duration-700 ease-out-soft" style={{ width: pct }} />
          {s.users !== null && <span aria-hidden className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-surface bg-lime-ink transition-[left] duration-700 ease-out-soft" style={{ left: pct }} />}
        </div>
        <div aria-hidden className="mt-1.5 flex justify-between text-[11px] text-faint tabular"><span>100</span><span>1K</span><span>10K</span><span>100K users</span></div>
      </div>
      <ul className="space-y-1.5 text-[13px] text-ink-2">
        {s.first && (
          <li className="flex items-start gap-2">
            <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-surface"><BrandLogo id={s.first.logo} size={12} title={s.first.name} /></span>
            <span>First to upgrade: <b className="font-medium text-ink">{s.first.name}</b> ({s.first.key.toLowerCase()}). Then {s.first.paid.name}, {s.first.paid.price}.</span>
          </li>
        )}
        {s.domain?.price && <li className="text-muted">+ the domain: {s.domain.price.firstYear} the first year{s.domain.price.renewal !== s.domain.price.firstYear ? `, then ${s.domain.price.renewal}` : ', the same after'}.</li>}
        {s.perSale.map((p) => <li key={p.id} className="text-muted">+ {p.name} takes {p.paid.price} per sale.</li>)}
        {!!s.uncounted.length && <li className="text-muted">{s.uncounted.map((p) => p.name).join(', ')}: limits we can’t turn into users. Check their page.</li>}
        {s.users !== null && <li className="text-[12px] text-faint">An estimate: hover any “fits about” to see how it’s worked out.</li>}
      </ul>
    </div>
  );
}

// --- browse by need ---------------------------------------------------------------------------------------------------
interface RowCtx { known: Map<string, boolean>; hosts: Set<string>; onConnect: (provider: string) => void; inStack: (p: Plan) => boolean; onToggle: (p: Plan) => void }

function Browse({ need, setNeed, ctx }: { need: Need; setNeed: (n: Need) => void; ctx: RowCtx }) {
  const [side, setSide] = useState(false);
  const list = plansFor(need);
  const n = NEEDS.find((x) => x.id === need)!;
  const NeedIcon = ICON[need];
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="g-browse" className="text-[17px] font-semibold tracking-[-0.025em]">Browse by need</h3>
        <div role="tablist" aria-label="How to show them" className="inline-flex rounded-full bg-raised p-0.5">
          {[['List', false], ['Side by side', true]].map(([label, v]) => (
            <button key={String(label)} type="button" role="tab" aria-selected={side === v} onClick={() => setSide(v as boolean)}
              className={cx('h-8 rounded-full px-3.5 text-[12.5px] font-medium transition', side === v ? 'bg-surface text-ink shadow-soft' : 'text-muted hover:text-ink')}>{label as string}</button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-[176px_minmax(0,1fr)]">
        {/* a menu, not a <select>: the pop-up puts the cursor in its first field, and this one would scroll it away */}
        <div className="md:hidden">
          <Menu label={`Need: ${n.label}. Pick another`} align="left" items={NEEDS.map((x) => { const I = ICON[x.id]; return { label: x.label, icon: <I size={15} />, onSelect: () => setNeed(x.id) }; })}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-line-strong bg-surface pl-3.5 pr-2.5 text-[13.5px] font-medium text-ink transition hover:bg-raised">
            <NeedIcon size={15} aria-hidden />{n.label}<ChevronDown size={14} aria-hidden className="text-muted" />
          </Menu>
        </div>
        <nav aria-label="Needs" className="hidden md:block">
          <ul className="space-y-0.5">
            {NEEDS.map((x) => {
              const Icon = ICON[x.id];
              const on = x.id === need;
              return (
                <li key={x.id}>
                  <button type="button" aria-current={on || undefined} onClick={() => setNeed(x.id)}
                    className={cx('flex h-9 w-full items-center gap-2.5 rounded-full px-3 text-left text-[13.5px] font-medium transition', on ? 'bg-ink text-bg' : 'text-ink-2 hover:bg-raised hover:text-ink')}>
                    <Icon size={15} aria-hidden className={on ? '' : 'text-muted'} />{x.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div key={need} className="animate-pop min-w-0 space-y-3">
          <p className="text-[13.5px] text-muted">{n.blurb}</p>
          {side ? <Compare key={need} list={list} ctx={ctx} /> : (
            <ul className="divide-y divide-line rounded-[20px] border border-line">
              {list.map((p) => <Row key={p.id} p={p} ctx={ctx} />)}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ p, ctx }: { p: Plan; ctx: RowCtx }) {
  const f = FREE[p.free];
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 transition first:rounded-t-[20px] last:rounded-b-[20px] hover:bg-raised/60">
      <HoverCard content={<PlanCard p={p} />}>
        <span tabIndex={0} className="flex min-w-0 flex-1 basis-[230px] cursor-default items-center gap-3 rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-blue">
          <Logo p={p} />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[14px] font-semibold tracking-[-0.01em]">{p.name}</span>
              {p.best && <Badge tone="lime" className="h-5 px-2 text-[11px]">Recommended</Badge>}
            </span>
            <span className="block text-[12.5px] text-muted">{p.key}</span>
          </span>
        </span>
      </HoverCard>
      <span className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 max-sm:w-full">
        <Badge tone={f.tone} className="h-6">{f.word}</Badge>
        <Fits p={p} />
        <span className="ml-auto flex items-center gap-1.5 sm:ml-1">
          <Action p={p} ctx={ctx} />
          <StackToggle p={p} ctx={ctx} />
        </span>
      </span>
    </li>
  );
}

const Logo = ({ p, size = 40 }: { p: Plan; size?: number }) => (
  <span className="grid shrink-0 place-items-center rounded-[13px] bg-raised" style={{ width: size, height: size }}><BrandLogo id={p.logo} size={Math.round(size * 0.5)} title={p.name} /></span>
);

// "fits ~5K users", with how that's worked out on hover; a domain shows its first-year and renewal price instead
function Fits({ p }: { p: Plan }) {
  if (p.price) {
    const trap = parseFloat(p.price.renewal.slice(1)) > parseFloat(p.price.firstYear.slice(1)) * 1.3;
    return <span className="text-[12.5px] tabular text-ink-2">{p.price.firstYear} <span className="text-faint">→</span> <span className={trap ? 'font-semibold text-warn' : undefined}>{p.price.renewal}</span><span className="text-faint">/yr</span></span>;
  }
  if (p.uncapped) return <span className="text-[12.5px] text-muted">No user cap</span>;
  if (p.fits === undefined && (!perUser(p.need) || p.free === 'none')) return null;
  const tip = p.fits !== undefined
    ? <div className="max-w-[240px] space-y-1"><p className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint">An estimate</p><p>{p.assumes}</p></div>
    : <p className="max-w-[240px]">Their limits don’t turn into a number of users. Check their page.</p>;
  return (
    <HoverCard content={tip}>
      <span tabIndex={0} className="cursor-help whitespace-nowrap rounded text-[12.5px] tabular text-ink-2 underline decoration-line-strong decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-blue">
        {p.fits !== undefined ? `fits ~${compact(p.fits)} users` : 'fits ?'}
      </span>
    </HoverCard>
  );
}

// A host Unit7 can put a site on goes straight there, that host chosen (it says if it still needs connecting). Otherwise
// Connect (Unit7's own pop-up), "On my server" (Add to my server), or their page
function Action({ p, ctx }: { p: Plan; ctx: RowCtx }) {
  if (p.need === 'hosting' && p.connect && ctx.hosts.has(p.connect)) return <Button size="sm" variant="soft" icon={<Rocket size={13} />} onClick={() => navigate(`/live?to=${encodeURIComponent(p.connect!)}`)} aria-label={`Put a site live on ${p.name}`}>Put it live</Button>;
  if (p.connect && ctx.known.has(p.connect)) return ctx.known.get(p.connect)
    ? <span className="inline-flex h-8 items-center gap-1.5 px-1.5 text-[12.5px] font-medium text-ok"><StatusMark state="ok" size={15} label="Connected" /><span className="max-sm:sr-only">Connected</span></span>
    : <Button size="sm" variant="soft" onClick={() => ctx.onConnect(p.connect!)} aria-label={`Connect ${p.name}`}>Connect</Button>;
  if (p.selfHost) return <Button size="sm" variant="soft" icon={<PackagePlus size={13} />} onClick={() => navigate('/add')} aria-label={`Put ${p.name} on my server`}>On my server</Button>;
  return (
    <a href={p.source} target="_blank" rel="noopener" aria-label={`${p.name}’s pricing page`} title={`${p.name}’s pricing page`}
      className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink"><ArrowUpRight size={15} /></a>
  );
}

function StackToggle({ p, ctx }: { p: Plan; ctx: RowCtx }) {
  if (!stackable(p)) return <span aria-hidden className="size-8" />;
  const on = ctx.inStack(p);
  const label = on ? `Take ${p.name} out of my stack` : `Put ${p.name} in my stack`;
  return (
    <button type="button" aria-pressed={on} aria-label={label} title={label} onClick={() => ctx.onToggle(p)}
      className={cx('grid size-8 shrink-0 place-items-center rounded-full transition active:scale-95',
        on ? 'bg-ink text-bg' : 'border border-line-strong text-muted hover:border-ink hover:bg-ink hover:text-bg')}>
      {on ? <Check size={14} strokeWidth={3} className="check-pop" /> : <Plus size={15} />}
    </button>
  );
}

// everything about one plan, in a hover card
function PlanCard({ p }: { p: Plan }) {
  const f = FREE[p.free];
  return (
    <div className="space-y-2.5">
      <p className="flex items-center gap-2"><BrandLogo id={p.logo} size={16} title={p.name} /><b className="min-w-0 flex-1 truncate font-semibold">{p.name}</b><Badge tone={f.tone} className="h-5 px-2 text-[11px]">{f.word}</Badge></p>
      {p.best && <p className="text-ink-2">{p.best}</p>}
      {p.price && <p className="text-ink-2">A .com: <b className="font-semibold text-ink">{p.price.firstYear}</b> the first year, then <b className="font-semibold text-ink">{p.price.renewal}</b> a year.</p>}
      <Facts title={p.free === 'none' ? 'What you get' : 'Free gives you'} items={p.limits} />
      {p.fits !== undefined && <p className="text-ink-2">Fits about <b className="font-semibold text-ink">{full(p.fits)}</b> users <span className="text-faint">(estimate: {(p.assumes ?? '').replace(/^Assumes /, 'assumes ').replace(/\.$/, '')})</span></p>}
      {!!p.gotchas.length && <Facts title="Watch out" items={p.gotchas} warn />}
      <p className="text-ink-2"><span className="text-faint">Then: </span><b className="font-medium text-ink">{p.paid.name}</b>, {p.paid.price}</p>
      <a href={p.source} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-[12px] font-medium text-blue-text hover:underline">Their page · checked {CHECKED_WORDS}<ArrowUpRight size={12} /></a>
    </div>
  );
}
const Facts = ({ title, items, warn }: { title: string; items: string[]; warn?: boolean }) => (
  <div>
    <p className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint">{title}</p>
    <ul className="mt-1 space-y-0.5">{items.map((x) => <li key={x} className="flex gap-1.5 text-ink-2"><span aria-hidden className={cx('mt-[7px] size-1 shrink-0 rounded-full', warn ? 'bg-warn' : 'bg-faint')} />{x}</li>)}</ul>
  </div>
);

// --- side by side: two or three of a need, each column swappable; sections line up across columns -------------------
function Compare({ list, ctx }: { list: Plan[]; ctx: RowCtx }) {
  const [ids, setIds] = useState(() => list.slice(0, 3).map((p) => p.id));
  const cols = ids.map(plan).filter((p): p is Plan => !!p);
  const options = list.map((p) => ({ value: p.id, label: p.name }));
  return (
    <div className={cx('grid gap-3', cols.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
      {cols.map((p, i) => {
        const f = FREE[p.free];
        return (
          <div key={i} className="row-span-6 grid grid-rows-subgrid gap-3 rounded-[20px] border border-line p-4">
            <div className="flex items-center gap-2.5">
              <Logo p={p} size={36} />
              <div className="min-w-0 flex-1 space-y-1">
                <ChipSelect label={`Column ${i + 1}`} value={p.id} onChange={(v) => setIds((x) => x.map((y, j) => (j === i ? v : y)))} options={options} />
                {p.best && <Badge tone="lime" className="h-5 px-2 text-[11px]">Recommended</Badge>}
              </div>
            </div>
            <Cell title={p.free === 'none' ? 'Price' : 'Free'}><span className="flex flex-wrap items-center gap-1.5"><Badge tone={f.tone} className="h-5 px-2 text-[11px]">{f.word}</Badge>{p.key}</span></Cell>
            <Cell title={p.price ? 'A .com' : 'Fits about'}>{p.price ? `${p.price.firstYear}, then ${p.price.renewal}/yr` : p.uncapped ? 'No user cap' : p.fits !== undefined ? <HoverCard content={<p className="max-w-[240px]">{p.assumes}</p>}><span tabIndex={0} className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-4">{full(p.fits)} users</span></HoverCard> : 'Check their page'}</Cell>
            <Cell title="Watch out">{p.gotchas[0] ?? 'Nothing big'}</Cell>
            {p.price ? <Cell title="Also">{p.limits.join(' · ')}</Cell> : <Cell title="Then">{p.paid.name}, {p.paid.price}</Cell>}
            <div className="flex flex-wrap items-center gap-2 self-end"><Action p={p} ctx={ctx} /><StackToggle p={p} ctx={ctx} /></div>
          </div>
        );
      })}
    </div>
  );
}
const Cell = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="min-w-0 text-[13px] text-ink-2"><p className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint">{title}</p><div className="mt-0.5">{children}</div></div>
);

// --- where it lives ---------------------------------------------------------------------------------------------------
const Coin = ({ size = 44 }: { size?: number }) => (
  <span aria-hidden className="grid shrink-0 place-items-center rounded-full bg-lime font-bold tracking-[-0.03em] text-lime-ink tabular" style={{ width: size, height: size, fontSize: size * 0.34 }}>$0</span>
);
const FAN = ['vercel', 'supabase', 'cloudflare', 'firebase'];

// Connections: one quiet but special card near the top; it opens the guide in a centred pop-up. Connect in the guide
// closes it and opens that provider's own connect pop-up on the page.
export function GuideCard({ onConnect }: { onConnect: (provider: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="illo-host lift group flex w-full items-center gap-3.5 rounded-[22px] border border-line bg-surface p-3 pr-4 text-left shadow-soft outline-none focus-visible:ring-2 focus-visible:ring-blue">
        <Illustration name="gift" size={50} className="-my-1 ml-0.5" />
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-semibold tracking-[-0.01em]">Start free</span>
          <span className="block text-[13px] text-muted">See what each service gives you for $0</span>
        </span>
        <span aria-hidden className="hidden items-center sm:flex">
          {FAN.map((id, i) => (
            <span key={id} className={cx('grid size-8 place-items-center rounded-full bg-raised ring-2 ring-surface transition-[margin] duration-300 ease-out-soft', i > 0 && '-ml-2 group-hover:ml-1')}>
              <BrandLogo id={id} size={15} />
            </span>
          ))}
        </span>
        <ArrowRight size={17} aria-hidden className="shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-ink" />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} size="xl" title={<span className="flex items-center gap-3"><Coin size={34} />Start free</span>}>
        <Guide intro onConnect={(id) => { setOpen(false); onConnect(id); }} />
      </Modal>
    </>
  );
}

// /guide: the same guide as a page; Connect goes to Connections with that provider's pop-up open
export function GuidePage() {
  return (
    <div>
      <PageHeader title="Start free" subtitle={<>What each service gives you for $0, and when you’d start paying. <span className="whitespace-nowrap">Checked {CHECKED_WORDS}.</span></>} />
      <div className="rounded-[28px] border border-line bg-surface p-4 shadow-soft sm:p-7">
        <Guide onConnect={(id) => navigate(`/connections?connect=${encodeURIComponent(id)}`)} />
      </div>
    </div>
  );
}
