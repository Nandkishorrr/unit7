// A domain from idea to live, in one centred pop-up: type a name and see six free domains with prices from your
// Hostinger account; buy one (people only: you type the domain and the price back, then hold to pay); then Unit7 sets
// it up step by step, live (DNS, your app, HTTPS, email protection, www, a check it's live) and ends on "it's live".
// Also for a domain you already own. openDomainLaunch() opens it from anywhere (⌘K, Home, the Map); mount
// <DomainLaunchHost /> once.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Clock, Globe, Loader2, Minus, Search, ShieldCheck, X } from 'lucide-react';
import { api, onLive, runTool, type ToolResult } from '../../lib/api';
import { BrandLogo } from '../../brand/BrandLogo';
import { A, Badge, Button, Field, HoldButton, Input, Modal, Skeleton, SwitchRow, Tabs, cx, toast, StatusMark } from '../../ui';

interface Idea { domain: string; available: boolean; alternative: boolean; price: { amount: number; currency: string; text: string; renews?: string } | null }
interface Ideas { name: string; exact?: { domain: string; available: boolean }; suggestions: Idea[]; canBuy: boolean; why?: string; checkout: string }
interface AppOption { id: string; label: string; sub?: string; provider?: string; logo?: string; url?: string; target: Record<string, unknown> }
interface Plan { domain: string; apps: AppOption[]; cloudflare: boolean; hostinger: boolean; steps: string[] }
interface LaunchStep { key: string; label: string; state: 'todo' | 'running' | 'ok' | 'waiting' | 'failed' | 'skipped'; note?: string }
interface Launched { domain: string; url: string; live: boolean; steps: LaunchStep[]; next?: string }

type Stage = { at: 'search' } | { at: 'buy'; idea: Idea; ideas: Ideas } | { at: 'setup'; domain: string } | { at: 'launch'; domain: string; target: Record<string, unknown>; dns: 'keep' | 'cloudflare'; app: string; prefer?: Prefer };
type Prefer = 'apex' | 'www'; // the main address; the other one sends visitors to it
const errText = (r: ToolResult) => (r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? r.why : '');
const BURST = ['#c6f432', '#1f5bff', '#8b5cf6', '#c6f432', '#26b5f0', '#1f5bff', '#d16bf5', '#c6f432'];

// --- open it from anywhere -------------------------------------------------------------------------------------------
let want: { domain?: string; own?: boolean } | null = null;
const subs = new Set<() => void>();
export function openDomainLaunch(o: { domain?: string; own?: boolean } = {}) { want = { ...o }; subs.forEach((f) => f()); }
export function DomainLaunchHost() {
  const w = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => want);
  return <DomainLaunch open={!!w} onClose={() => { want = null; subs.forEach((f) => f()); }} initial={w ?? undefined} />;
}

export function DomainLaunch({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: { domain?: string; own?: boolean } }) {
  const [stage, setStage] = useState<Stage>({ at: 'search' });
  // a fresh start each time it opens (straight to setting up, for a domain you already have)
  useEffect(() => { if (open) setStage(initial?.own && initial.domain ? { at: 'setup', domain: initial.domain } : { at: 'search' }); }, [open, initial?.own, initial?.domain]);
  const title = stage.at === 'search' ? 'Get a domain' : stage.at === 'buy' ? `Buy ${stage.idea.domain}` : stage.at === 'setup' ? `Set up ${stage.domain}` : stage.domain;
  return (
    <Modal open={open} onClose={onClose} title={<span className="flex items-center gap-2"><Globe size={18} aria-hidden className="text-blue-text" />{title}</span>} size="lg">
      {stage.at === 'search' && <SearchStage initial={initial} onPick={(idea, ideas) => setStage({ at: 'buy', idea, ideas })} onOwn={(domain) => setStage({ at: 'setup', domain })} />}
      {stage.at === 'buy' && <BuyStage idea={stage.idea} ideas={stage.ideas} onBack={() => setStage({ at: 'search' })} onBought={(domain) => setStage({ at: 'setup', domain })} />}
      {stage.at === 'setup' && <SetupStage domain={stage.domain} onBack={() => setStage({ at: 'search' })} onGo={(target, dns, app, prefer) => setStage({ at: 'launch', domain: stage.domain, target, dns, app, prefer })} />}
      {stage.at === 'launch' && <LaunchStage {...stage} onDone={onClose} onBack={() => setStage({ at: 'setup', domain: stage.domain })} />}
    </Modal>
  );
}

// --- 1. search -------------------------------------------------------------------------------------------------------
function SearchStage({ initial, onPick, onOwn }: { initial?: { domain?: string; own?: boolean }; onPick: (i: Idea, all: Ideas) => void; onOwn: (domain: string) => void }) {
  const [mode, setMode] = useState<'new' | 'own'>(initial?.own ? 'own' : 'new');
  const [q, setQ] = useState(initial?.domain ?? '');
  const [own, setOwn] = useState(initial?.own ? initial.domain ?? '' : '');
  const [state, setState] = useState<{ loading?: boolean; ideas?: Ideas; error?: string; code?: string }>({});
  const search = async () => {
    if (!q.trim()) return;
    setState({ loading: true });
    const r = await runTool('domain.ideas', { name: q.trim() }).catch((e: Error) => ({ status: 'error', error: { code: 'http', message: e.message } }) as ToolResult);
    setState(r.status === 'ok' ? { ideas: r.output } : { error: errText(r), code: r.status === 'error' ? r.error.code : undefined });
  };
  const ownOk = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(own.trim());
  return (
    <div className="space-y-5">
      <Tabs value={mode} onChange={setMode} tabs={[{ value: 'new', label: 'Find a new one' }, { value: 'own', label: 'Use one I have' }]} />
      {mode === 'new' ? (
        <>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void search(); }}>
            <label className="sr-only" htmlFor="domain-q">Name or domain</label>
            <Input id="domain-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Your idea, like “sunny bakery” or sunnybakery.com" className="h-12 flex-1 text-[15px]" autoFocus />
            <Button type="submit" variant="primary" size="lg" icon={<Search size={16} />} loading={state.loading} disabled={!q.trim()}>Search</Button>
          </form>
          {state.loading && <div className="grid gap-2.5 sm:grid-cols-2">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-[76px] rounded-[18px]" />)}</div>}
          {state.error && (
            <div className="rounded-[18px] bg-warn/10 px-4 py-3 text-[13.5px] text-warn">
              <p>{state.error}</p>
              {state.code === 'no_account' && <A href="/connections" className="mt-1.5 inline-flex items-center gap-1 font-medium text-blue-text hover:underline">Open Connections<ArrowUpRight size={13} /></A>}
            </div>
          )}
          {state.ideas && (
            <div className="space-y-3 animate-rise">
              {state.ideas.exact && !state.ideas.exact.available && <p className="text-[13px] text-muted"><span className="font-medium text-ink">{state.ideas.exact.domain}</span> is taken. These are free:</p>}
              {!state.ideas.suggestions.length ? <p className="rounded-[18px] border border-dashed border-line-strong px-4 py-6 text-center text-[13.5px] text-muted">Nothing free for that name. Try another word.</p> : (
                <ul className="grid gap-2.5 sm:grid-cols-2">
                  {state.ideas.suggestions.map((s, i) => (
                    <li key={s.domain} className="animate-rise" style={{ animationDelay: `${i * 45}ms` }}>
                      <button type="button" onClick={() => onPick(s, state.ideas!)}
                        className="group flex w-full items-center gap-3 rounded-[18px] border border-line bg-surface px-4 py-3.5 text-left shadow-soft transition hover:-translate-y-px hover:border-ink focus-visible:border-ink">
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2"><span className="truncate text-[15.5px] font-semibold tracking-[-0.015em]">{s.domain}</span>{i === 0 && !s.alternative && <Badge tone="lime">Best match</Badge>}</span>
                          <span className="block text-[12.5px] text-muted">{s.price ? <>{s.price.text} first year{s.price.renews && ` · then ${s.price.renews}`}</> : 'Price on Hostinger'}</span>
                        </span>
                        <ArrowUpRight size={16} aria-hidden className="shrink-0 rotate-45 text-faint transition group-hover:rotate-0 group-hover:text-ink" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[12px] text-faint">Free names and prices from your Hostinger account, checked just now.</p>
            </div>
          )}
        </>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ownOk) onOwn(own.trim().toLowerCase()); }}>
          <Field label="Your domain" hint="Bought anywhere. Unit7 points it at your app and sets up the rest.">
            <Input value={own} onChange={(e) => setOwn(e.target.value)} placeholder="example.com" className="h-12 text-[15px]" autoFocus />
          </Field>
          <div className="flex justify-end"><Button type="submit" variant="primary" disabled={!ownOk}>Next</Button></div>
        </form>
      )}
    </div>
  );
}

// --- 2. buy: people only, typed back, then hold to pay -----------------------------------------------------------------
function BuyStage({ idea, ideas, onBack, onBought }: { idea: Idea; ideas: Ideas; onBack: () => void; onBought: (domain: string) => void }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; checkout?: boolean } | null>(null);
  const [approval, setApproval] = useState<string | null>(null);
  const shown = idea.price?.text ?? '';
  const cents = (s: string) => { const v = s.replace(/[^\d.,]/g, '').replace(/,(\d{2})$/, '.$1').replace(/,/g, ''); return v ? Math.round(Number(v) * 100) : NaN; };
  const typed = name.trim().toLowerCase() === idea.domain && !!idea.price && cents(price) === idea.price.amount;
  const checkout = ideas.checkout.replace(/domain=[^&]*/, `domain=${encodeURIComponent(idea.domain)}`);
  const bought = () => { toast('ok', `${idea.domain} is yours`, 'Unit7 sets it up next.'); onBought(idea.domain); };
  const buy = async () => {
    setBusy(true); setError(null);
    const r = await runTool('domain.buy', { domain: idea.domain, confirmName: name.trim(), confirmPrice: price.trim() }).catch((e: Error) => ({ status: 'error', error: { code: 'http', message: e.message } }) as ToolResult);
    setBusy(false);
    if (r.status === 'ok') bought();
    else if (r.status === 'approval_required') setApproval(r.approvalId);
    else setError({ text: errText(r), checkout: r.status === 'error' && ['no_payment', 'cant_buy'].includes(r.error.code) });
  };
  // money is restricted: the request waits for an explicit OK, which an owner or admin gives right here
  const pay = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<ToolResult | { status: 'rejected' }>(`/api/approvals/${approval}/approve`, { body: { confirm: idea.domain } });
      if (r.status === 'ok') bought();
      else setError({ text: r.status === 'rejected' ? 'Not bought.' : errText(r as ToolResult), checkout: r.status === 'error' && ['no_payment', 'cant_buy'].includes(r.error.code) });
    } catch (e) { setError({ text: (e as Error).message }); }
    setBusy(false);
  };
  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack} className="-mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-muted hover:text-ink"><ArrowLeft size={14} />Other names</button>
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-[22px] bg-raised/60 px-5 py-4">
        <div className="min-w-0"><p className="text-[12.5px] text-muted">Your new domain</p><p className="truncate text-[22px] font-semibold tracking-[-0.03em]">{idea.domain}</p></div>
        {idea.price && <div className="text-right"><p className="text-[22px] font-semibold tabular tracking-[-0.03em]">{idea.price.text}</p><p className="text-[12px] text-muted">first year{idea.price.renews && `, then ${idea.price.renews}/year`}</p></div>}
      </div>
      {!ideas.canBuy || !idea.price ? (
        <div className="space-y-3 rounded-[18px] bg-warn/10 px-4 py-3.5 text-[13.5px] text-warn">
          <p>{ideas.why ?? 'Unit7 can’t buy this one through Hostinger’s API.'} Buy it on Hostinger, then come back: Unit7 sets it up from there.</p>
          <div className="flex flex-wrap gap-2">
            <a href={checkout} target="_blank" rel="noopener" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-medium text-bg hover:opacity-90">Buy on Hostinger<ArrowUpRight size={14} /></a>
            <Button size="md" variant="secondary" onClick={() => onBought(idea.domain)}>I bought it, set it up</Button>
          </div>
        </div>
      ) : approval ? (
        <div className="space-y-4 animate-rise">
          <p className="flex items-start gap-2 text-[13.5px] text-ink-2"><ShieldCheck size={16} className="mt-px shrink-0 text-ok" />One last check: this spends {shown} with the card on your Hostinger account.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setApproval(null)}>Not now</Button>
            <HoldButton onConfirm={pay} loading={busy} className="bg-blue text-white hover:brightness-110" fillClassName="bg-white/25">{`Pay ${shown}`}</HoldButton>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="flex items-start gap-2 text-[13px] text-muted"><ShieldCheck size={15} className="mt-px shrink-0 text-ok" />Only you can buy it. Unit7’s AI never spends money. Type both to confirm.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Type ${idea.domain}`}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={idea.domain} autoComplete="off" spellCheck={false} autoFocus /></Field>
            <Field label={`Type the price (${shown})`}><Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder={shown.replace(/[^\d.,]/g, '')} inputMode="decimal" autoComplete="off" /></Field>
          </div>
          <div className="flex justify-end"><Button variant="primary" size="lg" loading={busy} disabled={!typed} onClick={buy}>{`Buy for ${shown}`}</Button></div>
        </div>
      )}
      {error && (
        <div className="rounded-[16px] bg-bad/10 px-4 py-3 text-[13.5px] text-bad">
          <p>{error.text}</p>
          {error.checkout && <a href={checkout} target="_blank" rel="noopener" className="mt-1.5 inline-flex items-center gap-1 font-medium underline">Buy on Hostinger<ArrowUpRight size={13} /></a>}
        </div>
      )}
    </div>
  );
}

// --- 3. where it goes ------------------------------------------------------------------------------------------------
function SetupStage({ domain, onBack, onGo }: { domain: string; onBack: () => void; onGo: (target: Record<string, unknown>, dns: 'keep' | 'cloudflare', app: string, prefer: Prefer) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [app, setApp] = useState<string | null>(null);
  const [dns, setDns] = useState<'keep' | 'cloudflare'>('keep');
  const [www, setWww] = useState(false);
  useEffect(() => {
    void runTool('domain.launch', { domain }, { dryRun: true }).then((r) => { if (r.status === 'dry_run') { setPlan(r.plan); if (r.plan.apps.length === 1) setApp(r.plan.apps[0].id); } else setError(errText(r)); })
      .catch((e: Error) => setError(e.message));
  }, [domain]);
  const picked = plan?.apps.find((a) => a.id === app);
  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack} className="-mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-muted hover:text-ink"><ArrowLeft size={14} />Back</button>
      {error && <p className="rounded-[16px] bg-bad/10 px-4 py-3 text-[13.5px] text-bad">{error}</p>}
      <section>
        <h3 className="mb-2 text-[14px] font-semibold">Where should {domain} go?</h3>
        {!plan && !error ? <div className="grid gap-2 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[62px] rounded-[18px]" />)}</div>
          : plan && !plan.apps.length ? <p className="rounded-[18px] border border-dashed border-line-strong px-4 py-6 text-center text-[13.5px] text-muted">No apps to point it at yet. <A href="/projects" className="font-medium text-blue-text hover:underline">Deploy one first</A>, then come back.</p>
          : (
            <div role="radiogroup" aria-label="App" className="grid max-h-[300px] gap-2 overflow-y-auto overscroll-contain sm:grid-cols-2">
              {plan?.apps.map((a) => (
                <button key={a.id} type="button" role="radio" aria-checked={app === a.id} onClick={() => setApp(a.id)}
                  className={cx('flex items-center gap-3 rounded-[18px] border px-3.5 py-3 text-left transition', app === a.id ? 'border-blue bg-blue-soft/60 ring-4 ring-blue-soft' : 'border-line bg-surface hover:border-line-strong')}>
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-raised"><BrandLogo id={a.logo ?? a.provider ?? 'unit7'} size={18} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{a.label}</span>{a.sub && <span className="block truncate text-[12px] text-muted">{a.sub}</span>}</span>
                  {app === a.id && <Check size={16} className="check-pop shrink-0 text-blue-text" aria-hidden />}
                </button>
              ))}
            </div>
          )}
      </section>
      {plan && (
        <section>
          <h3 className="mb-2 text-[14px] font-semibold">DNS</h3>
          <div role="radiogroup" aria-label="DNS" className="grid gap-2 sm:grid-cols-2">
            {([['keep', plan.hostinger ? 'Keep it at Hostinger' : 'Keep it where it is', 'Nothing moves. Simplest.'], ['cloudflare', 'Move it to Cloudflare', plan.cloudflare ? 'Free, fast, and can point the bare domain anywhere.' : 'Connect Cloudflare first (free).']] as const).map(([v, t, d]) => (
              <button key={v} type="button" role="radio" aria-checked={dns === v} disabled={v === 'cloudflare' && !plan.cloudflare} onClick={() => setDns(v)}
                className={cx('rounded-[18px] border px-4 py-3 text-left transition disabled:opacity-50', dns === v ? 'border-ink ring-4 ring-raised' : 'border-line hover:border-line-strong')}>
                <span className="flex items-center gap-2 text-[14px] font-medium"><BrandLogo id={v === 'keep' ? (plan.hostinger ? 'hostinger' : 'unit7') : 'cloudflare'} size={16} />{t}</span>
                <span className="mt-0.5 block text-[12px] text-muted">{d}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {plan && !picked?.target.supabase && <SwitchRow title={`Use www.${domain} as the main address`} body={`${www ? `${domain} sends visitors to www.${domain}` : `www.${domain} sends visitors to ${domain}`}: same page, one address.`} checked={www} onChange={setWww} />}
      {plan && <p className="text-[12.5px] text-muted">Then Unit7 points it at your app and sets up HTTPS, email protection and www, then checks it’s live. Each step is checked, and it stops if one fails.</p>}
      <div className="flex justify-end"><Button variant="primary" size="lg" disabled={!picked} onClick={() => picked && onGo(picked.target, dns, picked.label, www ? 'www' : 'apex')}>Set it up</Button></div>
    </div>
  );
}

// --- 4. the launch, live ---------------------------------------------------------------------------------------------
function LaunchStage({ domain, target, dns, app, prefer = 'apex', onDone, onBack }: { domain: string; target: Record<string, unknown>; dns: 'keep' | 'cloudflare'; app: string; prefer?: Prefer; onDone: () => void; onBack: () => void }) {
  const first = useMemo<LaunchStep[]>(() => ['Domain ready', dns === 'cloudflare' ? 'DNS moves to Cloudflare' : 'DNS stays where it is', `Opens ${app}`, 'HTTPS', 'Email protection', prefer === 'www' ? `${domain} goes to www.${domain}` : `www goes to ${domain}`, 'Live check']
    .map((label, i) => ({ key: String(i), label, state: 'todo' as const })), [domain, dns, app, prefer]);
  const [steps, setSteps] = useState<LaunchStep[]>(first);
  const [done, setDone] = useState<Launched | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setDone(null); setError(null); setSteps(first);
    const off = onLive((e) => { if (e.type === 'domain.launch' && e.data?.domain === domain && live) setSteps(relabel(e.data.steps, app)); });
    void runTool('domain.launch', { domain, target, dns, prefer }).then((r) => {
      if (!live) return;
      if (r.status === 'ok') { setDone(r.output); setSteps(relabel(r.output.steps, app)); } else setError(errText(r));
    }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; off(); };
  }, [domain, target, dns, app, prefer, first, round]);
  const failed = steps.find((s) => s.state === 'failed');
  return (
    <div className="space-y-5">
      {done?.live ? (
        <div className="flex flex-col items-center px-2 pb-1 pt-3 text-center animate-rise">
          <span className="relative mb-4 grid size-20 place-items-center">
            <span aria-hidden className="burst absolute inset-0">{BURST.map((c, i) => <i key={i} style={{ background: c, ['--a' as string]: `${i * 45 + 20}deg`, animationDelay: `${120 + (i % 3) * 40}ms` }} />)}</span>
            <StatusMark state="ok" size={64} solid label="Live" />
          </span>
          <p className="text-[22px] font-semibold tracking-[-0.03em]">{domain} is live</p>
          <p className="mt-1 text-[13.5px] text-muted">With HTTPS, email protection and www. Unit7 keeps an eye on it.</p>
          <div className="mt-5 flex gap-2">
            <a href={done.url} target="_blank" rel="noopener" className="inline-flex h-11 items-center gap-1.5 rounded-full bg-blue px-5 text-[14px] font-medium text-white hover:brightness-110">Open<ArrowUpRight size={15} /></a>
            <Button variant="secondary" size="lg" onClick={onDone}>Done</Button>
          </div>
        </div>
      ) : (
        <p className="text-[13.5px] text-muted" aria-live="polite">{done ? done.next : error ?? `Setting up ${domain}. You can close this: it carries on and Activity says how it went.`}</p>
      )}
      <ol className="space-y-1.5" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s.key} className={cx('flex items-start gap-3 rounded-[16px] px-3.5 py-2.5 transition-colors', s.state === 'running' ? 'bg-blue-soft/60' : s.state === 'failed' ? 'bg-bad/8' : 'bg-raised/50')}>
            <Mark state={s.state} n={i + 1} />
            <div className="min-w-0 flex-1">
              <p className={cx('text-[13.5px] font-medium leading-snug', s.state === 'todo' && 'text-muted')}>{s.label}</p>
              {s.note && <p className={cx('mt-0.5 text-[12px] leading-snug', s.state === 'failed' ? 'text-bad' : s.state === 'waiting' ? 'text-warn' : 'text-muted')}>{s.note}</p>}
            </div>
          </li>
        ))}
      </ol>
      {!done?.live && (done || error) && (
        <div className="flex flex-wrap justify-end gap-2">
          {failed && <Button variant="ghost" onClick={onBack}>Change app</Button>}
          <Button variant="secondary" onClick={() => setRound((n) => n + 1)}>Try again</Button>
          <Button variant="dark" onClick={onDone}>Close</Button>
        </div>
      )}
    </div>
  );
}
// the server's labels, with "Opens your app" said with the app's name
const relabel = (steps: LaunchStep[], app: string) => steps.map((s) => (s.key === 'point' ? { ...s, label: `Opens ${app}` } : s));
function Mark({ state, n }: { state: LaunchStep['state']; n: number }) {
  const c = 'grid size-6 shrink-0 place-items-center rounded-full text-[11.5px] font-semibold';
  if (state === 'ok') return <span className={cx(c, 'check-pop bg-ok/12 text-ok')}><Check size={13} strokeWidth={2.6} aria-label="Done" /></span>;
  if (state === 'running') return <span className={cx(c, 'bg-blue text-white')}><Loader2 size={13} className="animate-spin" aria-label="Working" /></span>;
  if (state === 'waiting') return <span className={cx(c, 'bg-warn/12 text-warn')}><Clock size={13} aria-label="Waiting" /></span>;
  if (state === 'failed') return <span className={cx(c, 'bg-bad/10 text-bad')}><X size={13} strokeWidth={2.6} aria-label="Didn’t work" /></span>;
  if (state === 'skipped') return <span className={cx(c, 'bg-raised text-muted')}><Minus size={13} aria-label="Not needed" /></span>;
  return <span className={cx(c, 'bg-surface text-muted ring-1 ring-line-strong')}>{n}</span>;
}

// the numbered step mark, for other step-by-step pop-ups (servers/CoolifyDomain.tsx)
export { Mark as StepMark };
