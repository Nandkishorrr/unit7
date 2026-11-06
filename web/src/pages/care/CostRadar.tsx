// The cost radar: one big monthly number, a thin stacked bar of where it goes (by project), the providers that send the
// bills, and "save" ideas with one action each. Shares of a server and usage projected over the month are marked as
// estimates. compact: the version for Home's side panel (the number, the bar, the best two ideas, a link to /costs).
import { useState, type ReactNode } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Archive, Copy, PiggyBank, RefreshCw, Server, Sparkles, Trash2 } from 'lucide-react';
import { navigate } from '../../lib/router';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { act, Badge, Button, Card, CountUp, cx, Fresh, HoverCard, Illustration, Meter, PageHeader, Skeleton } from '../../ui';
import { tidy } from '../../lib/words';
import { LifecycleMenu } from '../lifecycle';
import { CloudBills } from '../Connections';
import { money, useTool, type Line, type Radar, type Saving } from './data';

// the reference categorical palette (validated for colour-blind separation), light and dark steps; projects take a slot
// by their key's alphabetical place so a colour follows the project, not its rank. Not-a-project slices are greys.
const PALETTE = `.cr{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#4a3aa7}
.dark .cr{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9}`;
const GREY: Record<string, string> = { shared: 'var(--faint)', room: 'var(--line-strong)' };
function colours(lines: Line[]) {
  const projects = lines.filter((l) => !GREY[l.key] && !l.key.startsWith('server:')).map((l) => l.key).sort();
  return (l: Line) => GREY[l.key] ?? (l.key.startsWith('server:') ? 'var(--muted)' : projects.indexOf(l.key) < 7 ? `var(--s${projects.indexOf(l.key) + 1})` : 'var(--faint)');
}
const Est = ({ on }: { on?: boolean }) => (on ? <span className="ml-1 text-[11px] font-normal text-faint" title="An estimate">est.</span> : null);

function Delta({ r }: { r: Radar }) {
  if (r.lastMonth == null || !r.lastMonth) return <span className="text-[12.5px] text-muted">Next month you’ll see how it compares</span>;
  const d = (r.total - r.lastMonth) / r.lastMonth;
  const Icon = d >= 0 ? ArrowUpRight : ArrowDownRight;
  return <span className="inline-flex items-center gap-1 text-[12.5px] text-ink-2"><Icon size={14} aria-hidden />{Math.abs(Math.round(d * 100))}% {d >= 0 ? 'more' : 'less'} than last month ({money(r.lastMonth, r.currency)})</span>;
}

// where the money goes: one thin bar, a 2px gap between projects, hover for each one's figure
function SplitBar({ r, limit }: { r: Radar; limit?: number }) {
  const [all, setAll] = useState(false);
  const lines = r.byProject;
  const sum = lines.reduce((n, l) => n + l.amount, 0);
  if (!sum) return null;
  const colour = colours(lines);
  const cut = limit ?? 10; // the biggest ten at rest; the rest on "Show all"
  const legend = all && !limit ? lines : lines.slice(0, cut);
  return (
    <div>
      <div className="flex h-3 w-full gap-[2px]" role="img" aria-label={`By project: ${lines.map((l) => `${l.name} ${money(l.amount, r.currency)}`).join(', ')}`}>
        {lines.map((l) => (
          <HoverCard key={l.key} content={<div className="text-[12.5px]"><p className="font-medium text-ink">{l.name}</p><p className="tabular text-ink-2">{money(l.amount, r.currency)} a month{l.estimate ? ' (an estimate)' : ''}</p>{l.note && <p className="mt-1 text-muted">{l.note}</p>}</div>}>
            <span tabIndex={0} className="block h-full min-w-[3px] rounded-[4px] outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-blue" style={{ width: `${(l.amount / sum) * 100}%`, background: colour(l) }} />
          </HoverCard>
        ))}
      </div>
      <ul className={cx('mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5', !limit && 'sm:grid-cols-2')}>
        {legend.map((l) => (
          <li key={l.key} className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: colour(l) }} />
            {l.projectId ? <button type="button" onClick={() => navigate(`/projects/${l.projectId}`)} className="min-w-0 truncate text-left text-ink-2 hover:text-ink hover:underline">{l.name}</button> : <span className="min-w-0 truncate text-ink-2">{l.name}</span>}
            <span className="tabular ml-auto shrink-0 font-medium text-ink">{money(l.amount, r.currency)}<Est on={l.estimate} /></span>
          </li>
        ))}
        {limit && lines.length > limit && <li className="text-[12px] text-muted">and {lines.length - limit} more</li>}
      </ul>
      {!limit && lines.length > cut && (
        <button type="button" aria-expanded={all} onClick={() => setAll((v) => !v)} className="mt-2 inline-flex h-8 items-center rounded-full px-2.5 text-[12.5px] font-medium text-blue-text transition hover:bg-blue-soft">
          {all ? 'Show the biggest ten' : `Show all ${lines.length}`}
        </button>
      )}
    </div>
  );
}

function Providers({ r, limit }: { r: Radar; limit?: number }) {
  const list = limit ? r.byProvider.slice(0, limit) : r.byProvider;
  if (!list.length) return null;
  return (
    <ul className="divide-y divide-line">
      {list.map((l) => (
        <li key={l.key} className="flex items-center gap-3 py-2">
          {l.provider === 'servers' ? <span className="grid size-6 place-items-center rounded-full bg-raised"><Server size={13} aria-hidden /></span> : <BrandLogo id={l.provider ?? l.key} size={22} />}
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{l.provider === 'servers' ? 'Your other servers' : providerName(l.provider ?? l.key)}</span>
          <span className="tabular text-[13px] font-medium text-ink">{money(l.amount, r.currency)}<Est on={l.estimate} /></span>
        </li>
      ))}
    </ul>
  );
}

const ICON: Record<Saving['kind'], ReactNode> = { idle: <Archive size={15} />, oversized: <Server size={15} />, duplicate: <Copy size={15} />, cleanup: <Trash2 size={15} /> };
function SaveAction({ s, reload }: { s: Saving; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const a = s.action;
  if (a.kind === 'lifecycle') return <span className="inline-flex items-center gap-2 text-[12.5px] text-muted">Archive or delete<LifecycleMenu item={a.item} onChanged={reload} label={`Archive or delete ${a.item.name}`} className="grid size-8 place-items-center rounded-full border border-line-strong bg-surface text-ink transition hover:bg-raised" /></span>;
  if (a.kind === 'open') return <Button size="sm" variant="soft" icon={<ArrowRight size={13} />} onClick={() => navigate(a.href)}>{a.label}</Button>;
  return <Button size="sm" variant="secondary" loading={busy} onClick={async () => { setBusy(true); if (await act(a.tool, a.input, { success: 'Done' })) reload(); setBusy(false); }}>{a.label}</Button>;
}
function SaveCard({ s, r, reload }: { s: Saving; r: Radar; reload: () => void }) {
  return (
    <li className="relative flex min-w-0 flex-col gap-2 rounded-[20px] bg-raised/70 p-4 has-[[aria-expanded=true]]:z-30">
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface text-ink-2">{ICON[s.kind]}</span>
        <p className="min-w-0 flex-1 text-[13.5px] font-medium text-ink">{s.title}</p>
        {s.amount ? <Badge tone="lime" className="tabular">Save ~{money(s.amount, r.currency)}/mo</Badge> : null}
      </div>
      <p className="line-clamp-4 text-[12.5px] text-muted">{tidy(s.detail)}</p>
      <div className="mt-auto flex justify-end pt-1"><SaveAction s={s} reload={reload} /></div>
    </li>
  );
}

export function CostRadar({ compact, className }: { compact?: boolean; className?: string }) {
  const { data: r, error, reload } = useTool<Radar>('cost.radar', {});
  const [checking, setChecking] = useState(false);
  if (error && !r) return <Card className={cx('p-5', className)}><p className="text-[13px] text-bad">{tidy(error)}</p></Card>;
  if (!r) return <Skeleton className={cx(compact ? 'h-[220px]' : 'h-[420px]', 'rounded-[24px]', className)} />;
  const check = async () => { setChecking(true); await reload({ refresh: true }); setChecking(false); };
  const pct = r.budget ? Math.round((r.total / r.budget) * 100) : 0;
  const head = (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium text-muted">This month{r.estimate && <HoverCard content={<p className="max-w-[240px] text-[12.5px] text-ink-2">An estimate: usage so far is projected over the month, and a project’s part of a server is its share of the server’s use.</p>}><span tabIndex={0} className="ml-1 cursor-help underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-blue">(estimate)</span></HoverCard>}</p>
        <p className={cx('mt-1 font-semibold tracking-[-0.04em] text-ink', compact ? 'text-[34px] leading-none' : 'text-[44px] leading-none md:text-[52px]')}>
          <CountUp value={r.total} format={(n) => money(n, r.currency, { cents: false })} />
        </p>
        <p className="mt-2"><Delta r={r} /></p>
      </div>
      <Button size="sm" variant="ghost" loading={checking} icon={<RefreshCw size={13} />} onClick={check} title="Reads your providers’ bills again">{compact ? '' : 'Check costs'}</Button>
    </div>
  );
  const budget = r.budget ? (
    <div className="mt-4">
      <Meter value={pct} label={`${pct}% of your monthly budget`} />
      <p className={cx('mt-1.5 text-[12px]', pct >= 100 ? 'text-bad' : pct >= 80 ? 'text-warn' : 'text-muted')}>{pct}% of your {money(r.budget, r.currency)} budget</p>
    </div>
  ) : !compact ? <p className="mt-4 text-[12.5px] text-muted">No monthly budget yet. <button type="button" className="font-medium text-blue-text hover:underline" onClick={() => navigate('/autopilot')}>Set one</button> so Unit7 warns you before a bill runs away.</p> : null;

  if (compact) {
    return (
      <Card className={cx('cr p-5', className)}>
        <style>{PALETTE}</style>
        {head}
        {budget}
        <div className="mt-4"><SplitBar r={r} limit={3} /></div>
        {r.savings.length > 0 && (
          <button type="button" onClick={() => navigate('/costs')} className="mt-4 flex w-full items-center gap-2.5 rounded-[18px] bg-lime-soft px-3.5 py-2.5 text-left text-[13px] text-ink transition hover:brightness-95">
            <PiggyBank size={16} aria-hidden className="shrink-0" />
            <span className="min-w-0 flex-1">{r.save ? <>Save about <b className="tabular">{money(r.save, r.currency)}</b> a month</> : `${r.savings.length} idea${r.savings.length > 1 ? 's' : ''} to spend less`}</span>
            <ArrowRight size={14} aria-hidden />
          </button>
        )}
        <button type="button" onClick={() => navigate('/costs')} className="mt-3 inline-flex h-8 items-center gap-1 rounded-full px-1 text-[12.5px] font-medium text-blue-text hover:underline">See all costs<ArrowRight size={13} /></button>
      </Card>
    );
  }

  return (
    <div className={cx('cr grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]', className)}>
      <style>{PALETTE}</style>
      <Card className="min-w-0 p-5 md:p-6">
        {head}
        {budget}
        <h3 className="mb-3 mt-6 text-[13.5px] font-semibold text-ink">By project</h3>
        {r.byProject.length ? <SplitBar r={r} /> : <p className="text-[13px] text-muted">Nothing to split yet.</p>}
        {r.byClient.length > 0 && (
          <>
            <h3 className="mb-2 mt-6 text-[13.5px] font-semibold text-ink">By client</h3>
            <ul className="space-y-1">{r.byClient.map((l) => <li key={l.key} className="flex items-center text-[13px]"><span className="min-w-0 flex-1 truncate text-ink-2">{l.name}</span><span className="tabular font-medium text-ink">{money(l.amount, r.currency)}<Est on={l.estimate} /></span></li>)}</ul>
          </>
        )}
      </Card>
      <Card className="min-w-0 p-5 md:p-6">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13.5px] font-semibold text-ink">Who sends the bills</h3>
          <Fresh at={r.checkedAt} every={86400_000} label="read" />
        </div>
        {r.byProvider.length ? <div className="mt-2"><Providers r={r} /></div> : (
          <div className="illo-host mt-3 flex flex-col items-center gap-2 py-3 text-center">
            <Illustration name="costs" size={96} />
            <p className="max-w-[300px] text-[13px] text-muted">No bills read yet. Check costs to read what your connected providers charge.</p>
          </div>
        )}
      </Card>
      <Card className="min-w-0 p-5 md:p-6 lg:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles size={16} aria-hidden className="text-ink-2" />
          <h3 className="text-[15px] font-semibold tracking-[-0.015em] text-ink">{r.save ? <>Save about <span className="tabular">{money(r.save, r.currency)}</span> a month</> : 'Ways to spend less'}</h3>
          <span className="text-[12.5px] text-muted">Each from what Unit7 measured. You decide; nothing is bought, resized or deleted by itself.</span>
        </div>
        {r.savings.length ? <ul className="stagger mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{r.savings.map((s) => <SaveCard key={s.id} s={s} r={r} reload={() => void reload()} />)}</ul>
          : <p className="mt-3 rounded-[18px] bg-ok/[0.07] px-4 py-3 text-[13px] text-ink">Nothing to trim right now: no idle projects, oversized servers or leftovers.</p>}
        {r.notes.length > 0 && <ul className="mt-4 space-y-1 text-[12px] text-muted">{r.notes.map((n) => <li key={n}>{tidy(n)}</li>)}</ul>}
      </Card>
    </div>
  );
}

// the /costs page
export function CostsPage() {
  return (
    <>
      <PageHeader title="Costs" subtitle="What everything costs this month, where it goes, and where to save." />
      <CostRadar />
      <CloudBills />
    </>
  );
}
