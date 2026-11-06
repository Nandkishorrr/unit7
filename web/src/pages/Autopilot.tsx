// Autopilot: how much Unit7 does without asking, per environment; one switch that stops it all;
// the budget and where alerts go; and a feed of everything Unit7 (and AI agents) did on their own,
// each reversible action with an Undo.
import { RulesCard } from './protect/Rules';
import { useId, useState } from 'react';
import { Pause, Play, Undo2, ShieldX, Wallet, Bell, KeyRound, History, Layers, Plus, RefreshCw, X, Network } from 'lucide-react';
import { useApi } from '../lib/api';
import { LEVEL_NAMES, reasonWords, tidy, toolWords, whoWords, type Tone } from '../lib/words';
import { A, act, ArrowLink, Badge, Button, Card, CardHeader, CountUp, Empty, Field, Fresh, HoldButton, IconCircle, Input, PageHeader, Select, Skeleton, SwitchRow, cx, timeAgo, Illustration } from '../ui';
import { BrandLogo } from '../brand/BrandLogo';
import { AlertChannels } from './Connections';
import { LoadError, WhoMark } from './Activity';
import type { Me } from '../App';
import { AUTO_SYNC, nextSyncWords, type AutoSync } from './map/data';
import { AskButton } from './Help';
import { useTool, type Radar } from './care/data';
import { AutofixCard } from './servers/Automation';

interface Env { id: string; name: string; kind: string; autonomy: number; project: string; projectId: string; earn: number; earn_cap: number | null; earn_note: string | null; earn_changed_at: string | null }
interface View {
  paused: boolean; pausedAt: string | null; levels: { level: number; label: string }[];
  environments: Env[];
  actions: { id: string; tool: string; who: string; why: string | null; result: string; at: string; undo: { tool: string; input: unknown; label: string } | null }[];
  rotation: { links: number; databases: number };
  autoSync: AutoSync;
  budget: { monthly: number | null; currency: string; actions: { scaleDown?: boolean; stopPreviews?: boolean }; manual: { label: string; monthly: number }[];
    costs: { provider: string; account: string; label: string; amount: number; kind: 'spent' | 'period' | 'monthly' | 'unknown'; original: string | null }[]; soFar: number; forecast: number; checkedAt: string | null };
  blocked: { total: number; denied: number; rejected: number; expired: number; reasons: { tool: string; why: string; who: string; count: number; last: string }[] };
}

// the five levels, in words a person would use (the project page shows the same words)
export const LEVELS = [
  'Unit7 watches and tells you. It changes nothing.',
  'Unit7 suggests each fix. You say yes to every one.',
  'Small, safe fixes happen on their own. Anything that touches your live app waits for you.',
  'Unit7 keeps your live app running by itself. Deleting things and other risky steps wait for you.',
  'Unit7 does it all. Only spending money and things you’ve ruled out wait for you.',
].map((means, i) => ({ name: LEVEL_NAMES[i]!, means }));
// One control for "how much Unit7 does alone", the same here and on a project's page: five words in a row, the chosen
// one dark, the ones below it tinted, the recommended one marked with a lime dot. A radio group, so arrow keys move.
const SHORT = ['Watch', 'Suggest', 'Ask first', 'Fix itself', 'Autopilot'];
export function LevelPicker({ value, onChange, rec, disabled, label, className }: { value: number; onChange: (n: number) => void; rec: number; disabled?: boolean; label: string; className?: string }) {
  const name = useId();
  return (
    // the soft blue fill runs from the left up to the level, and the black pill glides to it: both slide when you change it
    <div role="radiogroup" aria-label={label} style={{ ['--lv' as string]: value }} className={cx('relative isolate grid grid-cols-5 gap-1 rounded-full bg-surface p-1 shadow-soft ring-1 ring-line', className)}>
      <span aria-hidden className="absolute inset-y-1 left-1 -z-10 rounded-full bg-blue-soft transition-[width] duration-[420ms] ease-out-soft" style={{ width: 'calc((var(--lv) + 1) * ((100% - 24px) / 5 + 4px) - 4px)' }} />
      <span aria-hidden className="absolute inset-y-1 -z-10 rounded-full bg-ink shadow-[0_4px_12px_-4px_rgb(0_0_0/0.35)] transition-[left] duration-[420ms] ease-out-soft" style={{ width: 'calc((100% - 24px) / 5)', left: 'calc(4px + var(--lv) * ((100% - 24px) / 5 + 4px))' }} />
      {LEVELS.map((l, i) => (
        <label key={i} title={`${l.name}${i === rec ? ' (recommended)' : ''}`}
          className={cx('relative grid min-h-9 place-items-center rounded-full px-1 py-1 text-center text-[12px] font-medium leading-[1.15] transition-colors duration-300 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-blue',
            i === value ? 'text-bg' : i < value ? 'text-blue-text' : 'text-muted', disabled ? 'cursor-default' : 'cursor-pointer', !disabled && i !== value && 'hover:text-ink')}>
          <input type="radio" name={name} className="sr-only" checked={i === value} disabled={disabled} onChange={() => onChange(i)} aria-label={`${l.name}${i === rec ? ', recommended' : ''}`} />
          {SHORT[i]}
          {i === rec && <span aria-hidden className={cx('absolute -top-1 right-1 size-2.5 rounded-full bg-lime ring-2', i === value ? 'ring-ink' : 'ring-surface')} />}
        </label>
      ))}
    </div>
  );
}
// what we'd pick for someone who doesn't know: the live site fixes itself but asks before anything risky;
// test copies run on full autopilot
export const recommendedLevel = (kind: string) => (kind === 'production' ? 3 : 4);

export function AutopilotPage({ me }: { me: Me }) {
  const v = useApi<View>('/api/autopilot', { live: (e) => e.type.startsWith('autopilot.') || e.type.startsWith('policy.') || !e.live });
  const tools = useApi<{ name: string; title: string }[]>('/api/tools', { live: false });
  const human = me.role !== 'agent';
  const admin = ['owner', 'admin'].includes(me.role);
  const head = <PageHeader title="Autopilot" subtitle="How much Unit7 does on its own. Pause it all with one click, and undo what it did." />;
  if (!v.data) return <>{head}{v.error ? <LoadError what="Autopilot" reload={v.reload} /> : <AutopilotSkeleton />}</>;
  const d = v.data;
  const title = (name: string) => toolWords(name, tools.data?.find((t) => t.name === name)?.title);
  const projects = [...new Set(d.environments.map((e) => e.project))];

  return (
    <>
      {head}
      <div className="stagger grid gap-4 lg:grid-cols-12">
        <KillSwitch paused={d.paused} pausedAt={d.pausedAt} human={human} reload={v.reload} />
        <BlockedCard b={d.blocked} title={title} />
      </div>

      <section aria-labelledby="levels-h" className="mt-12 space-y-4">
        <div className="px-1">
          <h2 id="levels-h" className="text-[18px] font-semibold tracking-[-0.025em]">How much Unit7 does alone</h2>
          <p className="mt-0.5 text-[13.5px] text-muted">Pick a level for each environment. Spending money always waits for you.</p>
        </div>
        {!d.environments.length ? <Empty art={<Illustration name="deploy" size={96} />} title="No environments yet" body="They show up here when you create a project." /> : (
          <div className="stagger space-y-4">
            {projects.map((p) => (
              <Card key={p} className="p-5 md:p-6">
                <div className="mb-4 flex items-center gap-3">
                  <IconCircle size={36}><Layers size={17} /></IconCircle>
                  <h3 className="text-[16px] font-medium tracking-[-0.015em]">{p}</h3>
                </div>
                {/* two environments share the row; three or more get a column each */}
                <div className={cx('grid gap-3 md:grid-cols-2', d.environments.filter((e) => e.project === p).length > 2 && 'xl:grid-cols-3')}>
                  {d.environments.filter((e) => e.project === p).map((e) => <EnvLevel key={e.id} e={e} admin={admin} reload={v.reload} />)}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <div className="stagger mt-12 grid items-start gap-4 lg:grid-cols-12">
        <BudgetCard b={d.budget} admin={admin} reload={v.reload} />
        <div className="stagger grid min-w-0 gap-4 lg:col-span-5">
          <Card className="p-5 md:p-6">
            <CardHeader icon={<Bell size={20} />} title="Alerts" sub="Where Unit7 tells you things" actions={<ArrowLink href="/connections#alerts" label="Set up alerts" />} />
            <div className="mt-3"><AlertChannels /></div>
          </Card>
          <AutofixCard canChange={human && me.role !== 'readonly' && me.role !== 'auditor'} />
          <RotationCard rotation={d.rotation} admin={admin} reload={v.reload} />
          {d.autoSync && <AutoSyncCard a={d.autoSync} admin={admin} reload={v.reload} />}
          {human && <RulesCard />}
        </div>
        <UndoFeed actions={d.actions} title={title} human={human} reload={v.reload} />
      </div>
    </>
  );
}

function AutopilotSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading Autopilot">
      <div className="grid gap-4 lg:grid-cols-12"><Skeleton className="h-[240px] rounded-[24px] lg:col-span-8" /><Skeleton className="h-[240px] rounded-[24px] lg:col-span-4" /></div>
      <Skeleton className="h-[260px] rounded-[24px]" />
    </div>
  );
}

// --- the kill switch: a big dark card that says plainly what's happening ------------------------------------
function KillSwitch({ paused, pausedAt, human, reload }: { paused: boolean; pausedAt: string | null; human: boolean; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const set = async (p: boolean) => { setBusy(true); if (await act('autopilot.set', { paused: p }, { success: p ? 'Paused. Nothing changes without you.' : 'Autopilot is back on' })) reload(); setBusy(false); };
  return (
    <section aria-label="Pause everything" className={cx('relative flex min-w-0 flex-col overflow-hidden rounded-[24px] p-6 shadow-soft md:p-8 lg:col-span-8',
      paused ? 'bg-[#fff4e0] text-[#3d2600] ring-1 ring-[#f5c56b]/60 dark:bg-[#2a1d06] dark:text-[#ffe2ad]' : 'bg-[#111115] text-white ring-1 ring-white/5')}>
      {!paused && <span aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-[320px] rounded-full opacity-60" style={{ background: 'radial-gradient(closest-side, rgb(47 102 255 / 0.45), transparent)' }} />}
      <div className="relative flex items-center gap-3">
        <span className={cx('flex h-8 items-center gap-2 rounded-full px-3 text-[12.5px] font-medium', paused ? 'bg-[#f59e0b] text-[#1f1300]' : 'bg-white/10 text-white')}>
          <span className={cx('size-2 rounded-full', paused ? 'bg-[#1f1300]' : 'bg-lime animate-working')} />{paused ? 'Paused' : 'On'}
        </span>
        {paused && pausedAt && <span className="text-[13px] opacity-80">since {timeAgo(pausedAt)}</span>}
      </div>
      <h2 className="relative mt-6 text-[30px] font-semibold leading-tight tracking-[-0.04em] md:text-[38px]">{paused ? 'Everything is paused' : 'Autopilot is on'}</h2>
      <p className={cx('relative mt-2 max-w-xl text-[14.5px]', paused ? 'opacity-85' : 'text-white/70')}>
        {paused ? 'Unit7, Warden and your AI can look, but nothing changes until you turn it back on. You can still do things yourself.'
          : 'Unit7 and your AI act within each environment’s level below. Hit pause and every change stops at once.'}
      </p>
      <div className="relative mt-auto pt-7">
        {human ? (paused
          ? <Button variant="primary" size="lg" icon={<Play size={16} />} loading={busy} onClick={() => set(false)}>Turn Autopilot back on</Button>
          : <HoldButton size="lg" loading={busy} onConfirm={() => set(true)} icon={<Pause size={16} fill="currentColor" />}
              className="bg-white font-semibold text-[#111115] transition-colors hover:bg-[#ffe3e0] hover:text-[#b4231a]" fillClassName="bg-[#ff8a80]/55">
              Pause everything
            </HoldButton>)
          : <p className="text-[13px] opacity-70">An owner or admin can pause Autopilot.</p>}
      </div>
    </section>
  );
}

function BlockedCard({ b, title }: { b: View['blocked']; title: (t: string) => string }) {
  return (
    <Card className="flex min-w-0 flex-col p-5 md:p-6 lg:col-span-4">
      <CardHeader icon={<ShieldX size={20} />} title="Stopped this week" actions={<ArrowLink href="/activity" label="See what happened" />} />
      <p className="mt-6 text-[52px] font-semibold leading-none tracking-[-0.05em]"><CountUp value={b.total} /></p>
      <p className="mt-2 text-[13.5px] text-muted">risky thing{b.total === 1 ? '' : 's'} didn’t happen</p>
      {b.total > 0 && (
        <ul className="mt-4 space-y-1.5 text-[13px]">
          {([[b.rejected, 'you said not now'], [b.denied, 'your rules stopped'], [b.expired, 'waited too long and expired']] as const).filter(([n]) => n > 0).map(([n, w]) => (
            <li key={w} className="flex items-center gap-2"><span className="tabular w-6 font-semibold">{n}</span><span className="text-muted">{w}</span></li>
          ))}
        </ul>
      )}
      {b.reasons[0] && <p className="mt-auto truncate pt-4 text-[12.5px] text-muted" title={tidy(b.reasons[0].why)}>Latest: {title(b.reasons[0].tool).replace(/^\w/, (c) => c.toLowerCase())} by {whoWords(b.reasons[0].who)}</p>}
    </Card>
  );
}

// --- one environment's level --------------------------------------------------------------------------------
function EnvLevel({ e, admin, reload }: { e: Env; admin: boolean; reload: () => void }) {
  const [level, setLevel] = useState(e.autonomy);
  const live = e.kind === 'production';
  const pick = async (n: number) => {
    const before = level;
    setLevel(n);
    if (!(await act('environment.policy', { environmentId: e.id, autonomy: n }, { success: `${e.name}: ${LEVELS[n]!.name.toLowerCase()}` }))) setLevel(before);
    reload();
  };
  const cap = e.earn_cap ?? (live ? 3 : 4);
  const rec = recommendedLevel(e.kind);
  return (
    <div className="flex min-w-0 flex-col rounded-[20px] bg-raised/70 p-4">
      <p className="flex items-center gap-2 text-[14.5px] font-medium">{e.name}{live && <Badge tone="ember">Live</Badge>}</p>
      <LevelPicker className="mt-3" value={level} onChange={pick} rec={rec} disabled={!admin} label={`How much Unit7 does alone in ${e.project} ${e.name}`} />
      <p className="mt-3 flex flex-wrap items-center gap-2 text-[14px] font-semibold tracking-[-0.01em]">{LEVELS[level]!.name}{level === rec && <Badge tone="lime">Recommended</Badge>}</p>
      <p className="mt-0.5 text-[13px] text-muted">{LEVELS[level]!.means}</p>
      {admin && level !== rec && (
        <button type="button" onClick={() => pick(rec)} className="mt-2 inline-flex items-center gap-1.5 self-start rounded-full text-[13px] font-medium text-blue-text hover:underline">
          <span aria-hidden className="size-2 rounded-full bg-lime ring-1 ring-lime-ink/30" />Use the recommended level: {LEVELS[rec]!.name.toLowerCase()}
        </button>
      )}
      {admin && (
        <div className="mt-auto pt-3">
          <div className="border-t border-line">
            <SwitchRow title="Earn more freedom" body={`Moves up a level after a run of clean work${e.earn ? `, up to ${cap}` : ''}, and back down after a mistake.`} checked={!!e.earn}
              onChange={async (on) => { if (await act('environment.earn', { environmentId: e.id, on }, { success: on ? `${e.name} earns its freedom now` : `${e.name} stays where you put it` })) reload(); }}>
              {!!e.earn && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span className="text-muted">Highest level</span>
                  <Select value={String(cap)} onChange={async (val) => { if (await act('environment.earn', { environmentId: e.id, on: true, cap: Number(val) })) reload(); }}
                    options={LEVELS.slice(1).map((l, i) => ({ value: String(i + 1), label: `${i + 1} · ${l.name}` }))} />
                  {e.earn_note && <span className="text-muted">Last change: {tidy(e.earn_note)} ({timeAgo(e.earn_changed_at)})</span>}
                </div>
              )}
            </SwitchRow>
          </div>
        </div>
      )}
    </div>
  );
}

// --- budget ---------------------------------------------------------------------------------------------------
const DAY = 86_400_000; // Warden checks costs once a day
function BudgetCard({ b, admin, reload }: { b: View['budget']; admin: boolean; reload: () => void }) {
  const [checking, setChecking] = useState(false);
  const money = (n: number) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: b.currency || 'USD', currencyDisplay: 'narrowSymbol' }).format(n); } catch { return `${n.toFixed(2)} ${b.currency}`; } };
  // the same monthly number as Costs (servers' prices included, usage projected over the month)
  const radar = useTool<Radar>('cost.radar', {}).data;
  const month = radar?.total ?? b.forecast;
  const pct = b.monthly ? Math.round((month / b.monthly) * 100) : 0;
  const set = async (patch: Record<string, unknown>) => { if (await act('budget.set', patch, { success: 'Saved' })) reload(); };
  return (
    <Card className="flex min-w-0 flex-col p-5 md:p-6 lg:col-span-7">
      <CardHeader icon={<Wallet size={20} />} title="Budget" sub={<>Costs <Fresh at={b.checkedAt} every={DAY} className="text-[12.5px]" /></>}
        actions={<Button size="sm" variant="soft" icon={<RefreshCw size={13} />} loading={checking} onClick={async () => { setChecking(true); if (await act('budget.check', {}, { success: 'Costs checked' })) reload(); setChecking(false); }}>Check now</Button>} />
      <div className="mt-6 flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <p className="text-[13px] text-muted">This month{radar?.estimate ? ' (estimate)' : ''}</p>
          <p className="text-[40px] font-semibold leading-tight tracking-[-0.045em]"><CountUp value={month} format={money} /></p>
        </div>
        <div className="pb-1.5 text-[13px] text-muted">
          <A href="/costs" className="font-medium text-blue-text hover:underline">See where it goes</A>
          {b.monthly ? <p className={cx(pct >= 100 ? 'text-bad' : pct >= 80 ? 'text-warn' : '')}>{pct}% of your {money(b.monthly)} budget</p> : <p>No monthly budget yet</p>}
        </div>
      </div>
      {b.monthly ? <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-sunken"><div className={cx('h-full rounded-full transition-[width] duration-700', pct >= 100 ? 'bg-bad-solid' : pct >= 80 ? 'bg-[#f59e0b]' : 'bg-blue')} style={{ width: `${Math.min(100, pct)}%` }} /></div> : null}

      {b.costs.length > 0 && (
        <ul className="mt-5 divide-y divide-line rounded-[18px] border border-line px-3">
          {b.costs.map((c, n) => (
            <li key={n} className="flex items-center gap-3 py-2.5 text-[13px]">
              <BrandLogo id={c.provider} size={18} />
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              <span className="hidden min-w-0 truncate text-muted sm:inline" title={c.kind === 'unknown' ? c.original ?? undefined : undefined}>{c.kind === 'unknown' ? 'not in the total' : c.kind === 'monthly' ? 'per month' : 'this month'}</span>
              <span className={cx('tabular w-24 text-right', c.kind === 'unknown' ? 'text-muted' : 'font-medium')}>{c.kind === 'unknown' ? 'Unknown' : money(c.amount)}</span>
            </li>
          ))}
        </ul>
      )}

      {admin && (
        <div className="mt-6 space-y-5 border-t border-line pt-5">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Field label="Monthly budget"><Input type="number" min={0} inputMode="decimal" defaultValue={b.monthly ?? ''} placeholder="No limit"
              onBlur={(e) => { const n = e.target.value === '' ? null : Number(e.target.value); if (n !== b.monthly) void set({ monthly: n }); }} /></Field>
            <Field label="Currency"><div><Select className="w-full sm:w-28" value={b.currency} onChange={(c) => void set({ currency: c })} options={['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY'].map((c) => ({ value: c, label: c }))} /></div></Field>
          </div>
          <div>
            <p className="text-[13px] font-medium text-ink-2">When the budget runs out</p>
            <p className="text-[12.5px] text-muted">These trim Unit7’s own servers, not other companies’ bills.</p>
            <div className="divide-y divide-line">
              <SwitchRow title="Keep busy apps at their smallest size" checked={!!b.actions.scaleDown} onChange={(on) => void set({ scaleDown: on })} />
              <SwitchRow title="Stop preview copies of pull requests" checked={!!b.actions.stopPreviews} onChange={(on) => void set({ stopPreviews: on })} />
            </div>
          </div>
          <ManualCosts b={b} set={set} money={money} />
        </div>
      )}
    </Card>
  );
}

function ManualCosts({ b, set, money }: { b: View['budget']; set: (p: Record<string, unknown>) => Promise<void>; money: (n: number) => string }) {
  return (
    <div>
      <p className="text-[13px] font-medium text-ink-2">Costs Unit7 can’t read</p>
      <p className="text-[12.5px] text-muted">Plans like Supabase Pro or Render. Add them so the total is right.</p>
      {b.manual.length > 0 && (
        <ul className="mt-2 divide-y divide-line">
          {b.manual.map((m, n) => (
            <li key={n} className="flex items-center gap-3 py-2 text-[13px]">
              <span className="flex-1">{m.label}</span><span className="tabular text-muted">{money(m.monthly)} a month</span>
              <button type="button" aria-label={`Remove ${m.label}`} className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-bad" onClick={() => void set({ manual: b.manual.filter((_, k) => k !== n) })}><X size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      <form className="mt-3 grid grid-cols-[1fr_7.5rem_auto] gap-2" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const label = String(f.get('label') ?? '').trim(), monthly = Number(f.get('monthly')); if (label && monthly >= 0) { void set({ manual: [...b.manual, { label, monthly }] }); e.currentTarget.reset(); } }}>
        <Input name="label" required aria-label="What it is" placeholder="e.g. Supabase Pro" />
        <Input name="monthly" required type="number" min={0} step="0.01" aria-label="Cost per month" placeholder="Per month" />
        <Button variant="soft" icon={<Plus size={14} />}>Add</Button>
      </form>
    </div>
  );
}

// --- what Unit7 did on its own, with Undo ------------------------------------------------------------------------
const RESULT: Record<string, [Tone, string]> = { success: ['ok', 'Done'], error: ['bad', 'Didn’t work'], denied: ['bad', 'Blocked'], pending_approval: ['warn', 'Asked you'] };
function UndoFeed({ actions, title, human, reload }: { actions: View['actions']; title: (t: string) => string; human: boolean; reload: () => void }) {
  const [more, setMore] = useState(false);
  const list = more ? actions : actions.slice(0, 8);
  return (
    <Card className="min-w-0 p-5 md:p-6 lg:col-span-12">
      <CardHeader icon={<History size={20} />} title="What Unit7 did on its own" sub="Anything it can take back has an Undo." />
      {!actions.length ? <p className="mt-5 rounded-[18px] bg-raised px-4 py-6 text-center text-[13.5px] text-muted">Nothing yet. What Warden or your AI changes on its own shows up here.</p> : (
        <ul className="mt-4 divide-y divide-line">
          {list.map((a) => {
            const [tone, word] = RESULT[a.result] ?? ['neutral', a.result];
            const who = whoWords(a.who);
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <WhoMark who={who} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px]"><span className="font-medium">{title(a.tool)}</span></p>
                  <p className="truncate text-[12.5px] text-muted" title={a.why ? tidy(a.why) : undefined}>{who}{a.why && !/external agent/.test(a.why) ? ` · ${reasonWords(a.why)}` : ''} · {timeAgo(a.at)}</p>
                </div>
                <Badge tone={tone} solid={tone !== 'neutral'}>{word}</Badge>
                {human && a.result === 'error' && <AskButton label="Ask why" prompt={`Unit7 tried to ${title(a.tool).toLowerCase()} on its own and it didn’t work${a.why ? ` (${reasonWords(a.why)})` : ''}. What went wrong, and what should I do?`} />}
                {human && a.undo && a.result === 'success' && (
                  <Button size="sm" variant="secondary" icon={<Undo2 size={13} />} onClick={async () => { if (confirm(`${a.undo!.label}?`) && await act(a.undo!.tool, a.undo!.input, { success: 'Undone' })) reload(); }}>{a.undo.label}</Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {actions.length > 8 && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setMore(!more)}>{more ? 'Show less' : `Show all ${actions.length}`}</Button>}
    </Card>
  );
}

// --- changing secrets on a schedule -----------------------------------------------------------------------------
function RotationCard({ rotation, admin, reload }: { rotation: View['rotation']; admin: boolean; reload: () => void }) {
  const every = (n: number) => (n ? `Every ${n} days` : 'Never');
  return (
    <Card className="flex flex-col p-5 md:p-6">
      <CardHeader icon={<KeyRound size={20} />} title="Change keys on a schedule" />
      <p className="mt-3 text-[13px] text-muted">A key found in an app’s code is changed at once. These change on a schedule too.</p>
      <div className="mt-2 divide-y divide-line">
        {([['links', 'Keys between your apps', 'No downtime: the old key keeps working for a day.'], ['databases', 'Database passwords', 'Apps redeploy at 3am UTC, and it’s undone if one doesn’t come back.']] as const).map(([k, label, hint]) => (
          <div key={k} className="py-3.5">
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 text-[14px] font-medium">{label}</p>
              {admin ? <Select value={String(rotation[k])} onChange={async (val) => { if (await act('secrets.rotation', { [k]: Number(val) }, { success: 'Saved' })) reload(); }}
                options={[0, 30, 60, 90, 180, 365].map((n) => ({ value: String(n), label: n === 90 ? `${every(n)} (recommended)` : every(n) }))} /> : <Badge>{every(rotation[k])}</Badge>}
            </div>
            <p className="mt-1 text-[12.5px] text-muted">{hint}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

// --- keeping the map up to date ------------------------------------------------------------------------------
function AutoSyncCard({ a, admin, reload }: { a: AutoSync; admin: boolean; reload: () => void }) {
  const label = AUTO_SYNC.find((o) => o.value === a.every)?.label ?? a.every;
  const next = a.lastSyncAt ? nextSyncWords(a) : '';
  return (
    <Card className="flex flex-col p-5 md:p-6">
      <CardHeader icon={<Network size={20} />} title="Keep the map up to date" />
      <p className="mt-3 text-[13px] text-muted">Unit7 looks at every connected account again on this schedule. A new account shows up within a minute either way.</p>
      <div className="mt-2 py-3.5">
        <label className="flex items-center gap-3">
          <span className="min-w-0 flex-1 text-[14px] font-medium">Auto-sync</span>
          {admin ? <Select value={a.every} onChange={async (val) => { if (await act('sync.schedule', { every: val }, { success: 'Saved' })) reload(); }} options={AUTO_SYNC} /> : <Badge>{label}</Badge>}
        </label>
        <p className="mt-1 text-[12.5px] text-muted">{a.lastSyncAt ? `Synced ${timeAgo(a.lastSyncAt)}${next ? ` · ${next}` : ''}` : 'Not synced yet'}</p>
      </div>
    </Card>
  );
}
