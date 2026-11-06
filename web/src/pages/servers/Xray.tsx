// The pieces of the server X-ray, shared by the server page, the Map and the chat cards: the storage bar,
// project cards with their actions, the trust badge and the "Not part of a project" bucket (Coolify's connect card is
// in ./CoolifyTile.tsx). The data comes from server.xray / server.usage (shaped in ./xray.ts).
import { navigate } from '../../lib/router';
import { ProtectionBadge, type Level } from '../protect';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, ExternalLink, Loader2, MoreHorizontal, RotateCw, Rocket, ScrollText, SquareStop } from 'lucide-react';
import { BrandLogo } from '../../brand/BrandLogo';
import { A, AiButton as UiAiButton, Button, Dot, cx, stepAction, toast, StatusMark, type ToastAction } from '../../ui';
import { runTool, type ToolResult } from '../../lib/api';
import { askOnHome } from '../Help';
import { Menu } from '../kit';
import { Sure, Outcome, said, useProgress } from '../chat/cards/kit';
import { OWNER_NAME, TRUST, canDeploy, coolifyKind, healthTone, healthWords, money, ownerLogo, partLogo, size, type Bar, type Card, type Trust, type Usage, type XPart, type Xray } from './shape';

export const call = async (name: string, input: unknown): Promise<ToolResult> => {
  try { return await runTool(name, input); } catch (e) { return { status: 'error', error: { code: 'network', message: (e as Error).message } } as ToolResult; }
};
const errOf = (r: ToolResult) => (r.status === 'error' ? r.error.message : r.status === 'denied' || r.status === 'approval_required' ? r.why : 'Not allowed');

// --- colors: a fixed slot per project (validated for color-blind separation, light and dark) ---
const SERIES = [['#2a78d6', '#3987e5'], ['#eb6834', '#d95926'], ['#1baf7a', '#199e70'], ['#eda100', '#c98500'], ['#e87ba4', '#d55181'], ['#008300', '#008300'], ['#4a3aa7', '#9085e9'], ['#e34948', '#e66767']];
export const seriesColor = (i: number) => (i < 0 ? 'light-dark(#a1a1aa, #5c5c66)' : `light-dark(${SERIES[i % 8]![0]}, ${SERIES[i % 8]![1]})`);

// --- the server's X-ray, its usage, its price ---
export function useServerXray(serverId: string, o: { auto?: boolean } = { auto: true }) {
  const [x, setX] = useState<Xray | null>(null);
  const [xErr, setXErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [u, setU] = useState<Usage | null>(null);
  const [uErr, setUErr] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [price, setPriceState] = useState<{ monthly: number | null; currency?: string; source?: string } | null>(null);
  const loadUsage = async () => {
    const r = await call('server.usage', { serverId });
    if (r.status === 'ok') { setU(r.output as Usage); setUErr(null); } else setUErr(errOf(r));
  };
  const loadPrice = async () => { const r = await call('server.price', { serverId }); if (r.status === 'ok') setPriceState(r.output as never); };
  const busy = useRef(false);
  const scan = async () => {
    if (busy.current) return undefined; // one X-ray at a time (and once, when React runs the effect twice)
    busy.current = true;
    setScanning(true);
    const r = await call('server.xray', { serverId });
    busy.current = false;
    setScanning(false);
    if (r.status === 'ok') { setX(r.output as Xray); setXErr(null); } else setXErr(errOf(r));
    return r.status === 'ok';
  };
  useEffect(() => {
    if (!o.auto) return;
    setX(null); setU(null); setXErr(null); setUErr(null);
    // the X-ray first: usage reuses it instead of a second trip
    void scan().then((ran) => { if (ran !== undefined) void Promise.all([loadUsage(), loadPrice()]); });
  }, [serverId]);
  const measure = async () => {
    setMeasuring(true);
    const r = await call('server.sizes', { serverId, fresh: true });
    setMeasuring(false);
    if (r.status !== 'ok') { toast('bad', 'Couldn’t measure the disk', errOf(r), { action: stepAction(r, { input: { serverId }, retry: measure }) }); return; }
    if ((r.output as { stale?: unknown }).stale) toast('warn', 'The server didn’t answer', 'Showing the last measurement.');
    await loadUsage();
  };
  const setPrice = async (monthly: number | null, currency: string) => {
    const r = await call('server.price', { serverId, monthly, currency });
    if (r.status === 'ok') { setPriceState(r.output as never); return true; }
    toast('bad', 'Couldn’t save the price', errOf(r));
    return false;
  };
  const rescan = async () => { if (await scan() !== undefined) await loadUsage(); };
  return { x, xErr, scanning, u, uErr, measuring, price, rescan, measure, setPrice, reloadUsage: loadUsage };
}
export type ServerXray = ReturnType<typeof useServerXray>;
// what a project costs a month: Unit7's split of the price, or the share times a price set since
export const costOf = (c: Card, u: Usage | null, price: { monthly: number | null } | null) =>
  c.cost ?? (price?.monthly && u ? Math.round((u.projects.find((s) => s.id === c.id)?.share ?? 0) * price.monthly * 100) / 100 || undefined : undefined);

// --- an AI action: a request in Home's ask box (nothing runs until it's sent), in the app's AI-button look ---
export function AiButton({ prompt, children, size = 'sm', className, strong }: { prompt: string; children: ReactNode; size?: 'sm' | 'md'; className?: string; strong?: boolean }) {
  return (
    <UiAiButton type="button" size={size} strong={strong} title="Opens Home with this request ready. Nothing happens until you send it."
      onClick={(e) => { e.stopPropagation(); askOnHome(prompt); }} className={cx('relative z-10', className)}>
      {children}
    </UiAiButton>
  );
}

// --- logos ---
export function OwnerTile({ owner, size = 40, className, children }: { owner: string; size?: number; className?: string; children?: ReactNode }) {
  const id = ownerLogo(owner);
  return (
    <span title={`Run by ${OWNER_NAME[owner] ?? owner}`} className={cx('relative grid shrink-0 place-items-center bg-raised', className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.32) }}>
      {id ? <BrandLogo id={id} size={Math.round(size * 0.5)} /> : <span className="text-[12px] font-semibold text-muted">?</span>}
      {children}
    </span>
  );
}
export function PartLogos({ parts, size = 16 }: { parts: XPart[] | string[]; size?: number }) {
  const ids = [...new Set((parts as (XPart | string)[]).map((p) => (typeof p === 'string' ? p : partLogo(p))))].slice(0, 4);
  return (
    <span className="flex -space-x-1">
      {ids.map((id) => <span key={id} className="grid place-items-center rounded-full bg-surface ring-2 ring-surface" style={{ width: size + 6, height: size + 6 }}><BrandLogo id={id} size={size} /></span>)}
    </span>
  );
}

// --- Seen / Understood / Managed / Owned, with what it means on hover or focus ---
export function TrustBadge({ trust, owner, className }: { trust: Trust; owner?: string; className?: string }) {
  const t = TRUST[trust] ?? TRUST.seen;
  const tip = trust === 'understood' && owner && owner !== 'unmanaged' ? `Unit7 knows what it is and that ${OWNER_NAME[owner] ?? owner} runs it. Connect ${OWNER_NAME[owner] ?? owner} so Unit7 can manage it for you.` : t.tip;
  const tone = trust === 'owned' ? 'bg-ink text-bg' : trust === 'managed' ? 'bg-blue-soft text-blue-text' : trust === 'understood' ? 'bg-lime-soft text-ink-2' : 'bg-raised text-muted';
  return (
    <span tabIndex={0} aria-label={`${t.word}: ${tip}`} className={cx('group/trust relative z-10 inline-flex h-6 shrink-0 cursor-help items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-blue', tone, className)}>
      <span aria-hidden className={cx('size-1.5 rounded-full', trust === 'owned' ? 'bg-lime' : trust === 'managed' ? 'bg-blue' : trust === 'understood' ? 'bg-[#65a30d]' : 'bg-faint')} />
      {t.word}
      <span role="tooltip" className="pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-2 w-60 -translate-x-1/2 rounded-[14px] bg-[#111115] px-3 py-2 text-[12px] font-normal leading-snug text-white opacity-0 shadow-float transition-opacity group-hover/trust:visible group-hover/trust:opacity-100 group-focus-visible/trust:visible group-focus-visible/trust:opacity-100">{tip}</span>
    </span>
  );
}

// --- the storage bar: projects, the system, "can be cleaned up" (hatched) and free room ---
export function StorageBar({ label, bar, note, title, compact }: { label: ReactNode; bar: Bar; note?: ReactNode; title?: string; compact?: boolean }) {
  const [on, setOn] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { const r = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(r); }, []);
  const pct = (v: number) => (bar.total ? (v / bar.total) * 100 : 0);
  const h = hover != null ? bar.segs[hover] : undefined;
  const words = bar.segs.map((s) => `${s.name} ${size(s.value)}`).join(', ');
  return (
    <div className="min-w-0" title={title}>
      <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[12.5px]">
        <span className="font-medium text-ink">{label}</span>
        <span className="tabular text-muted">{note}</span>
      </p>
      <div className="relative mt-1.5" onMouseLeave={() => setHover(null)}>
        <div role="img" aria-label={`${typeof label === 'string' ? label : 'Storage'}: ${words}`} className={cx('flex w-full gap-[2px] overflow-hidden rounded-full bg-sunken', compact ? 'h-2.5' : 'h-3.5')}>
          {bar.segs.map((s, i) => s.kind === 'free' ? null : (
            <span key={s.id} onMouseEnter={() => setHover(i)}
              className={cx('block h-full shrink-0 transition-[width,opacity] duration-700 ease-out-soft first:rounded-l-full', s.kind === 'clean' && 'hatch bg-raised', hover != null && hover !== i && 'opacity-60')}
              style={{ width: on ? `max(${pct(s.value)}%, 3px)` : 0, background: s.kind === 'clean' ? undefined : seriesColor(s.color), transitionDelay: `${i * 50}ms` }} />
          ))}
        </div>
        {h && h.kind !== 'free' && (
          <span role="tooltip" className="animate-pop pointer-events-none absolute bottom-full left-0 z-20 mb-2 rounded-[12px] bg-[#111115] px-2.5 py-1.5 text-[12px] text-white shadow-float"
            style={{ left: `clamp(0px, ${pct(bar.segs.slice(0, hover!).reduce((n, s) => n + s.value, 0))}%, calc(100% - 180px))` }}>
            <span className="font-medium">{h.name}</span> · {size(h.value)} <span className="text-white/60">({Math.max(1, Math.round(pct(h.value)))}%)</span>
          </span>
        )}
      </div>
    </div>
  );
}
export function Legend({ bars, className }: { bars: Bar[]; className?: string }) {
  const seen = new Map<string, Bar['segs'][number]>();
  for (const b of bars) for (const s of b.segs) if (s.kind !== 'free' && !seen.has(s.id)) seen.set(s.id, s);
  return (
    <ul className={cx('flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-ink-2', className)}>
      {[...seen.values()].map((s) => (
        <li key={s.id} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cx('size-2.5 rounded-[3px]', s.kind === 'clean' && 'hatch bg-raised ring-1 ring-line-strong')} style={s.kind === 'clean' ? undefined : { background: seriesColor(s.color) }} />{s.name}
        </li>
      ))}
    </ul>
  );
}

// --- one Coolify action, followed to its end (a deploy waits until it's live or failed) ---
export function useCoolify(serverId: string) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ key: string; tone: 'ok' | 'bad' | 'info'; text: string; log?: string[]; ask?: string; step?: ToastAction } | null>(null);
  const lines = useProgress(['coolify.control'], !!busy);
  const run = async (key: string, p: XPart, action: 'start' | 'stop' | 'restart' | 'deploy' | 'rollback', extra: Record<string, unknown> = {}) => {
    if (!p.coolify) return;
    setBusy(key); setDone(null);
    const r = await call('coolify.control', { serverId, uuid: p.coolify.uuid, kind: coolifyKind(p), action, ...extra });
    setBusy(null);
    const o = r.status === 'ok' ? (r.output as { status: string; logTail?: string[] }) : undefined;
    const failed = !!o && /fail|cancel/.test(o.status);
    const word = { start: 'started', stop: 'stopped', restart: 'restarted', deploy: 'deployed', rollback: 'rolled back' }[action];
    if (o && !failed) setDone({ key, tone: 'ok', text: `${p.name} ${word}${/still/.test(o.status) ? ', still finishing in Coolify' : ''}.` });
    else if (o) setDone({ key, tone: 'bad', text: `${p.name} didn’t ${action === 'deploy' ? 'deploy' : action}: Coolify says ${o.status.replace(/_/g, ' ')}.`, log: o.logTail,
      ask: `Why did ${p.name}’s ${action === 'rollback' ? 'roll back' : action} fail through Coolify? Read its build log and tell me the fix.` });
    else setDone({ key, ...said(r, '', { input: { serverId }, retry: () => run(key, p, action, extra) }) });
  };
  return { busy, done, lines, run, clear: () => setDone(null) };
}
// Coolify's own step names, as a person would say them
export const progressWords = (l?: string) => {
  const m = /^Coolify: (.*)$/.exec(l ?? '')?.[1]?.toLowerCase();
  if (!l) return 'Asking Coolify…';
  if (!m) return l;
  return /queued/.test(m) ? 'Waiting its turn in Coolify…' : /in progress/.test(m) ? 'Coolify is on it…' : /running/.test(m) ? 'Starting up…' : /exited|stopped/.test(m) ? 'Stopping…' : `Coolify: ${m}`;
};
export function ActionOutcome({ c, k }: { c: ReturnType<typeof useCoolify>; k: string }) {
  if (c.busy === k) return <p role="status" className="mt-2 flex items-center gap-2 rounded-[14px] bg-blue-soft px-3 py-2 text-[12.5px] text-blue-text"><Loader2 size={13} className="animate-spin" />{progressWords(c.lines.at(-1))}</p>;
  if (c.done?.key !== k) return null;
  return (
    <div>
      <Outcome tone={c.done.tone} step={c.done.step}>{c.done.text}</Outcome>
      {c.done.log?.length ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-[14px] bg-[#111115] p-3 font-mono text-[11.5px] leading-relaxed text-white/80">{c.done.log.join('\n')}</pre> : null}
      {c.done.ask && <AiButton className="mt-2" prompt={c.done.ask}>Ask Unit7 why it failed</AiButton>}
    </div>
  );
}

// --- a project card ---
export interface CardCtx {
  x: Xray; serverName: string; human: boolean;
  open?: (c: Card, section?: string) => void;           // the drawer
  projectHref?: (name: string) => string | undefined;   // Unit7's own projects
  onConnect?: () => void;                               // scroll to the Coolify connect card
  cost?: (c: Card) => number | undefined; currency?: string; shield?: (c: Card) => Level | undefined;
}
const tone = (c: Card) => healthTone(c.health);
export function ProjectCard({ c, ctx, compact }: { c: Card; ctx: CardCtx; compact?: boolean }) {
  const cool = useCoolify(ctx.x.serverId);
  const [sure, setSure] = useState(false);
  const managed = c.owner === 'coolify' && canDeploy(ctx.x) && !!c.main?.coolify;
  const cost = ctx.cost?.(c);
  const href = c.owner === 'unit7' ? ctx.projectHref?.(c.name) : undefined;
  const t = tone(c);
  const url = c.domains[0] && `https://${c.domains[0]}`;
  const k = `card:${c.id}`;
  const busy = cool.busy === k;
  const fix = t === 'bad' || t === 'warn';
  // who runs it is the logo on the left (its name on hover)
  const facts = [c.what, c.environment].filter(Boolean).join(' · ');
  return (
    <article className={cx('lift relative flex min-w-0 flex-col rounded-[22px] border bg-surface p-4 shadow-soft', t === 'bad' ? 'border-bad/30' : t === 'warn' ? 'border-[#f59e0b]/40' : 'border-line', compact && 'p-3.5')}>
      <header className="flex items-start gap-3">
        <OwnerTile owner={c.owner} size={compact ? 34 : 40} />
        <div className="min-w-0 flex-1">
          <h3 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold tracking-[-0.015em]">
            <Dot tone={t === 'idle' ? 'idle' : t} />
            {ctx.open ? <button type="button" onClick={() => ctx.open!(c)} className="min-w-0 truncate text-left outline-none after:absolute after:inset-0 after:rounded-[22px] focus-visible:after:ring-2 focus-visible:after:ring-blue">{c.name}</button>
              : <span className="truncate">{c.name}</span>}
          </h3>
          <p className="truncate text-[12.5px] text-muted" title={facts}>{facts}</p>
        </div>
        {cost != null && <span className="tabular shrink-0 rounded-full bg-raised px-2 py-0.5 text-[12px] font-medium text-ink-2" title="This project’s share of the server’s monthly price, from what it uses right now">{money(cost, ctx.currency)}/mo</span>}
      </header>

      <p className={cx('mt-2.5 line-clamp-2 text-[12.5px]', t === 'bad' ? 'text-bad' : t === 'warn' ? 'text-warn' : 'text-ink-2')}>{healthWords(c.health)}</p>

      {!compact && c.domains.length > 0 && (
        <ul className="relative z-10 mt-2.5 flex flex-wrap gap-1.5">
          {c.domains.slice(0, 2).map((d) => (
            <li key={d}><a href={`https://${d}`} target="_blank" rel="noopener" className="inline-flex h-7 max-w-[200px] items-center gap-1 rounded-full border border-line bg-surface px-2.5 text-[12px] font-medium text-ink-2 transition hover:border-line-strong hover:text-ink"><span className="truncate">{d}</span><ArrowUpRight size={12} className="shrink-0 text-faint" /></a></li>
          ))}
          {c.domains.length > 2 && <li className="inline-flex h-7 items-center px-1 text-[12px] text-muted">+{c.domains.length - 2}</li>}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        <PartLogos parts={c.logos} size={compact ? 13 : 15} />
        <TrustBadge trust={c.trust} owner={c.owner} />
        {ctx.shield?.(c) && <button type="button" className="relative z-10" title="See its copies" onClick={() => navigate('/protect')}><ProtectionBadge level={ctx.shield(c)!} /></button>}
        {c.mem != null && c.mem > 0 && (
          <span className="ml-auto flex min-w-0 items-center gap-2 text-[11.5px] text-muted" title={`Memory right now${c.disk ? `, and ${size(c.disk)} on disk` : ''}`}>
            <span className="tabular truncate">{size(c.mem)}</span>
            <span aria-hidden className="h-1.5 w-12 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full bg-blue" style={{ width: `${Math.max(4, Math.min(100, (c.memShare ?? 0) * 100 * 3))}%` }} /></span>
          </span>
        )}
      </div>

      {!compact && (
        <div className="relative z-10 mt-auto flex flex-wrap items-center gap-1.5 pt-3.5">
          {fix && <AiButton strong prompt={`On ${ctx.serverName}, ${c.name} has a problem: ${healthWords(c.health).toLowerCase()}. Find out why and fix it.`}>Fix it</AiButton>}
          {/* its domains above already open it */}
          {url && !c.domains.length && <a href={url} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1 rounded-full border border-line-strong bg-surface px-3 text-[12.5px] font-medium transition hover:bg-raised">Open<ArrowUpRight size={12} /></a>}
          {managed && <>
            <Button size="sm" variant="secondary" icon={<ScrollText size={13} />} onClick={() => ctx.open?.(c, 'logs')}>Logs</Button>
            {!fix && <Button size="sm" variant="secondary" icon={<RotateCw size={13} />} loading={busy} disabled={!ctx.human || !!cool.busy} onClick={() => void cool.run(k, c.main!, 'restart')}>Restart</Button>}
            <Menu label={`More for ${c.name}`} className="grid size-8 place-items-center rounded-full border border-line-strong bg-surface text-ink transition hover:bg-raised" items={[
              ...(fix ? [{ label: 'Restart', icon: <RotateCw size={15} />, onSelect: () => void cool.run(k, c.main!, 'restart'), disabled: !ctx.human }] : []),
              { label: 'Deploy again', hint: 'Coolify builds and starts the latest version', icon: <Rocket size={15} />, onSelect: () => void cool.run(k, c.main!, 'deploy'), disabled: !ctx.human },
              ...(ctx.x.coolify?.dashboard ? [{ label: 'Open in Coolify', icon: <ExternalLink size={15} />, onSelect: () => window.open(ctx.x.coolify!.dashboard, '_blank', 'noopener') }] : []),
              { label: 'Stop', hint: 'Takes it offline until you start it', icon: <SquareStop size={15} />, danger: true, onSelect: () => setSure(true), disabled: !ctx.human },
            ]}><MoreHorizontal size={15} /></Menu>
          </>}
          {c.owner === 'coolify' && !managed && !c.system && (
            <button type="button" onClick={ctx.onConnect} className="h-8 rounded-full px-2 text-[12px] font-medium text-blue-text hover:bg-blue-soft">{ctx.x.coolify?.connected ? 'Needs a token that can deploy' : 'Connect Coolify to manage it'}</button>
          )}
          {href && <A href={href} className="inline-flex h-8 items-center gap-1 rounded-full border border-line-strong bg-surface px-3 text-[12.5px] font-medium transition hover:bg-raised">Manage<ArrowUpRight size={12} /></A>}
          {!managed && c.owner !== 'coolify' && c.owner !== 'unit7' && !fix && !c.system && <AiButton prompt={`On ${ctx.serverName}, what is ${c.name} and what can I do with it?`}>Ask about it</AiButton>}
        </div>
      )}
      {sure && <div className="relative z-10"><Sure text={`${c.name} goes offline until you start it again.`} yes="Stop it" onNo={() => setSure(false)} onYes={() => { setSure(false); void cool.run(k, c.main!, 'stop'); }} /></div>}
      <div className="relative z-10"><ActionOutcome c={cool} k={k} /></div>
    </article>
  );
}

// --- what isn't part of any project ---
// what isn't part of a project, in words: "1 program · 1 stored data folder · 3 GB of old images nobody uses"
export function looseOf(x: Xray) {
  const parts = x.loose.map((id) => x.parts.find((p) => p.id === id)).filter(Boolean) as XPart[];
  const n = (k: XPart['kind']) => parts.filter((p) => p.kind === k).length;
  const bits = [n('app') + n('service') && `${n('app') + n('service')} program${n('app') + n('service') === 1 ? '' : 's'}`, n('database') && `${n('database')} database${n('database') === 1 ? '' : 's'}`,
    n('volume') && `${n('volume')} stored data folder${n('volume') === 1 ? '' : 's'}`, n('job') && `${n('job')} scheduled job${n('job') === 1 ? '' : 's'}`, n('domain') && `${n('domain')} domain${n('domain') === 1 ? '' : 's'}`].filter(Boolean) as string[];
  const unused = x.disk?.imagesUnused;
  return { parts, bits, unused, words: [...bits, unused ? `${size(unused)} of old images nobody uses` : ''].filter(Boolean).join(' · ') };
}
export function LooseBucket({ x, className }: { x: Xray; className?: string }) {
  const { parts, bits, unused } = looseOf(x);
  if (!parts.length && !unused) return null;
  return (
    <section className={cx('flex flex-wrap items-center gap-3 rounded-[22px] border border-dashed border-line-strong bg-surface/60 p-4', className)}>
      <div className="min-w-[200px] flex-1">
        <h3 className="text-[14px] font-semibold">Not part of a project</h3>
        <p className="mt-0.5 text-[12.5px] text-muted">{[...bits, unused ? `${size(unused)} of old images nobody uses` : ''].filter(Boolean).join(' · ') || 'Nothing'}</p>
        {parts.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {parts.slice(0, 6).map((p) => (
              <li key={p.id} title={healthWords(p.health)} className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border border-line bg-surface pl-1 pr-2.5 text-[12px] font-medium text-ink-2">
                <span className="grid size-5 place-items-center rounded-full bg-raised"><BrandLogo id={partLogo(p)} size={11} /></span><span className="truncate">{p.name}</span>{p.health && p.health.status !== 'ok' && <Dot tone={healthTone(p.health) === 'idle' ? 'idle' : healthTone(p.health)} />}
              </li>
            ))}
            {parts.length > 6 && <li className="inline-flex h-7 items-center text-[12px] text-muted">+{parts.length - 6} more</li>}
          </ul>
        )}
      </div>
      <AiButton prompt={`On ${x.serverName}, look at what isn't part of a project and help me tidy it up safely. Tell me what each thing is first.`}>Tidy up</AiButton>
    </section>
  );
}

// a small "Coolify connected" chip, with what the token may do on hover
export function CoolifyChip({ x }: { x: Xray }) {
  if (!x.coolify) return null;
  const on = !!x.coolify.connected;
  return (
    <span title={on ? `Coolify ${x.coolify.version ?? ''} is connected${canDeploy(x) ? ': Unit7 can restart and deploy through it' : ': this token can only look'}` : 'Coolify runs here and isn’t connected yet'}
      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line-strong bg-surface pl-1.5 pr-2.5 text-[12.5px] font-medium text-ink-2">
      <BrandLogo id="coolify" size={14} />Shared with Coolify{on && <StatusMark state="ok" size={13} label="Shared" />}
    </span>
  );
}

// skeleton cards while the X-ray comes back
export function CardsSkeleton({ n = 4 }: { n?: number }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-hidden>{Array.from({ length: n }, (_, i) => <div key={i} className="skeleton h-[188px] rounded-[22px]" style={{ animationDelay: `${i * 90}ms` }} />)}</div>;
}
