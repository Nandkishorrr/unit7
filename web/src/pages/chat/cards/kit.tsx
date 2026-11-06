// What every chat card is made of: the frame (icon circle, title, count, a way through to the page), a
// list that shows 6 then "Show all", an inline "Are you sure?", and the shared facts the cards look up
// (the map and the projects graph), fetched once and shared by every card on screen.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowUpRight, ChevronDown, Loader2 } from 'lucide-react';
import { api, onLive, runTool, type ToolResult } from '../../../lib/api';
import { navigate } from '../../../lib/router';
import { A, Badge, Button, CountUp, IconCircle, cx, stepAction, type ToastAction } from '../../../ui';
import { askOnHome } from '../../Help';
import { fillAsk } from '../../Agent';
import { derive, type Asset, type Derived, type MapData } from '../../map/data';
import { LIST_MAX, type Managed, type Tone } from './shape';

// --- shared lookups: one request per thing per 20 seconds, however many cards ask ---
const cache = new Map<string, { at: number; p: Promise<any> }>();
function cached<T>(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 20_000) return hit.p;
  const p = load();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}
const toolOut = (name: string, input: object = {}) => runTool(name, input).then((r) => (r.status === 'ok' ? r.output : Promise.reject(new Error(r.status === 'error' ? r.error.message : r.status))));
export const refreshWorld = () => { cache.clear(); window.dispatchEvent(new Event('unit7:cards-refresh')); };

export function useLoad<T>(key: string | null, load: () => Promise<T>) {
  const [s, set] = useState<{ data?: T; error?: string }>({});
  const [n, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((x) => x + 1);
    window.addEventListener('unit7:cards-refresh', on);
    return () => window.removeEventListener('unit7:cards-refresh', on);
  }, []);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    cached(key, load).then((data) => alive && set({ data }), (e: Error) => alive && set({ error: e.message }));
    return () => { alive = false; };
  }, [key, n]);
  return s;
}

export interface Svc { id: string; name: string; kind: string; status: string; href: string; projectId: string; project: string; env: string; stack?: string; domains: { id: string; hostname: string; status: string; tls?: string }[]; config?: any; server_id?: string | null; current_deployment_id?: string | null }
export interface Graph { servers: any[]; projects: any[]; foundProjects?: any[]; accounts: any[] }
// The world as the cards see it: the map (every domain, app, server) and Unit7's own projects.
export function useWorld(o: { map?: boolean } = {}) {
  const g = useLoad<Graph>('graph', () => api('/api/graph'));
  const m = useLoad<MapData>(o.map ? 'map' : null, () => toolOut('map.get'));
  const d = useLoad<Managed[]>(o.map ? 'domains' : null, () => toolOut('domain.list'));
  return useMemo(() => {
    const svcs = new Map<string, Svc>();
    for (const p of g.data?.projects ?? []) for (const e of p.environments ?? []) for (const s of e.services ?? []) {
      svcs.set(s.id, { ...s, href: `/projects/${p.id}/services/${s.id}`, projectId: p.id, project: p.name, env: e.name, stack: s.config?.detection?.stack, domains: s.domains ?? [] });
    }
    const v: Derived | null = m.data ? derive(m.data) : null;
    const seen = new Map<string, number>();
    for (const a of v?.assets ?? []) if (a.kind === 'app') seen.set(a.name, (seen.get(a.name) ?? 0) + 1);
    // the map's way of telling three apps called "web" apart: "acme · web (staging)"
    const label = (a: Asset) => {
      const sv = a.end?.kind === 'unit7' ? svcs.get(a.end.serviceId!) : undefined;
      if (sv) { const env = sv.env.toLowerCase(); return `${sv.project} · ${a.name}${/^prod/.test(env) || a.name.toLowerCase().includes(env) ? '' : ` (${env})`}`; }
      if (a.kind === 'app' && (seen.get(a.name) ?? 0) > 1 && a.url) return `${a.name} · ${a.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}`;
      return a.name;
    };
    const svcLabel = (s?: Svc) => (s ? `${s.project} · ${s.name}${/^prod/i.test(s.env) || s.name.toLowerCase().includes(s.env.toLowerCase()) ? '' : ` (${s.env.toLowerCase()})`}` : undefined);
    return {
      graph: g.data, map: m.data, v, managed: d.data ?? [], error: g.error ?? m.error, ready: !!g.data && (!o.map || !!m.data || !!m.error),
      svc: (id?: string | null) => (id ? svcs.get(id) : undefined), svcs: [...svcs.values()], label, svcLabel,
      server: (id?: string | null) => (g.data?.servers ?? []).find((s) => s.id === id),
      assetOf: (serviceId?: string) => v?.assets.find((a) => a.end?.kind === 'unit7' && a.end.serviceId === serviceId),
      assetByName: (name: string) => v?.assets.find((a) => a.name === name),
    };
  }, [g.data, g.error, m.data, m.error, d.data, o.map]);
}
export type World = ReturnType<typeof useWorld>;

// --- the frame every card shares ---
export function Frame({ icon, tone = 'neutral', title, count, sub, href, hrefLabel, right, children, className }: {
  icon: ReactNode; tone?: 'neutral' | 'blue' | 'soft' | 'lime' | 'ok' | 'bad' | 'warn' | 'dark'; title: ReactNode; count?: number; sub?: ReactNode; href?: string; hrefLabel?: string;
  right?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <section className={cx('@container animate-rise w-full min-w-0 rounded-[24px] border border-line bg-surface p-4 shadow-soft @md:p-5', className)}>
      <header className="flex items-center gap-3">
        <IconCircle tone={tone} size={36}>{icon}</IconCircle>
        <div className="min-w-0 flex-1">
          <h3 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold tracking-[-0.015em] text-ink">
            <span className="truncate">{href ? <A href={href} className="hover:underline decoration-line-strong underline-offset-4">{title}</A> : title}</span>
            {count != null && <span className="tabular shrink-0 rounded-full bg-raised px-2 py-0.5 text-[12px] font-medium text-ink-2"><CountUp value={count} duration={600} /></span>}
          </h3>
          {sub && <p className="truncate text-[12.5px] text-muted">{sub}</p>}
        </div>
        {right}
        {href && (
          <A href={href} aria-label={hrefLabel ?? `Open ${typeof title === 'string' ? title : 'this'}`} title={hrefLabel}
            className="grid size-8 shrink-0 place-items-center rounded-full border border-line-strong text-ink transition hover:border-ink hover:bg-ink hover:text-bg">
            <ArrowUpRight size={15} />
          </A>
        )}
      </header>
      {children && <div className="mt-3.5">{children}</div>}
    </section>
  );
}

// 6, then "Show all n"
export function Fold<T>({ items, max = LIST_MAX, children, className, as = 'ul' }: { items: T[]; max?: number; children: (it: T, i: number) => ReactNode; className?: string; as?: 'ul' | 'div' }) {
  const [all, setAll] = useState(false);
  const shown = all || items.length <= max ? items : items.slice(0, max);
  const List = as;
  return (
    <>
      <List className={cx('stagger', className)}>{shown.map((it, i) => children(it, i))}</List>
      {items.length > max && (
        <button type="button" onClick={() => setAll((a) => !a)} aria-expanded={all}
          className="mt-1.5 inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-blue-text transition hover:bg-blue-soft">
          {all ? 'Show fewer' : `Show all ${items.length}`}<ChevronDown size={14} className={cx('transition-transform', all && 'rotate-180')} />
        </button>
      )}
    </>
  );
}

// a status as a dot and a word; the dot breathes while something is happening, and glows when live
const DOT: Record<Tone | 'work', string> = { ok: 'bg-ok', warn: 'bg-[#f59e0b]', bad: 'bg-bad', idle: 'bg-faint/60', work: 'bg-blue' };
export function LiveDot({ tone, glow }: { tone: Tone | 'work'; glow?: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0" aria-hidden>
      {(glow || tone === 'work') && <span className={cx('absolute inset-0 rounded-full opacity-60', DOT[tone], tone === 'work' ? 'animate-working' : 'animate-ping [animation-duration:2.4s]')} />}
      <span className={cx('relative inline-block size-2 rounded-full', DOT[tone])} />
    </span>
  );
}
const PILL: Record<Tone | 'work', 'ok' | 'warn' | 'bad' | 'neutral' | 'info'> = { ok: 'ok', warn: 'warn', bad: 'bad', idle: 'neutral', work: 'info' };
export function Pill({ tone, children, glow }: { tone: Tone | 'work'; children: ReactNode; glow?: boolean }) {
  return <Badge tone={PILL[tone]} className="gap-1.5"><LiveDot tone={tone} glow={glow} />{children}</Badge>;
}

// a small round button with a tooltip; for the row's quick actions
export function IconBtn({ label, onClick, href, children, busy, danger, external }: { label: string; onClick?: () => void; href?: string; children: ReactNode; busy?: boolean; danger?: boolean; external?: boolean }) {
  const cls = cx('grid size-8 shrink-0 place-items-center rounded-full border border-line-strong bg-surface text-ink-2 transition hover:border-ink/40 hover:text-ink disabled:opacity-50',
    danger && 'hover:border-bad/50 hover:text-bad');
  if (href) return external
    ? <a href={href} target="_blank" rel="noopener" aria-label={label} title={label} className={cls} onClick={(e) => e.stopPropagation()}>{children}</a>
    : <A href={href} aria-label={label} title={label} className={cls}>{children}</A>;
  return <button type="button" aria-label={label} title={label} disabled={busy} onClick={(e) => { e.stopPropagation(); onClick?.(); }} className={cls}>{busy ? <Loader2 size={14} className="animate-spin" /> : children}</button>;
}

// "Are you sure?" right where you clicked: one line, the risk in plain words, yes or no
export function Sure({ text, yes, onYes, onNo, busy }: { text: ReactNode; yes: string; onYes: () => void; onNo: () => void; busy?: boolean }) {
  return (
    <div role="alertdialog" aria-label="Are you sure?" className="animate-pop mt-2 flex flex-wrap items-center gap-2 rounded-[16px] border border-bad/25 bg-bad/6 px-3 py-2.5">
      <p className="min-w-[180px] flex-1 text-[12.5px] text-ink-2"><span className="font-medium text-ink">Are you sure? </span>{text}</p>
      <Button size="sm" variant="ghost" onClick={onNo} disabled={busy}>Cancel</Button>
      <Button size="sm" variant="danger" onClick={onYes} loading={busy} autoFocus>{yes}</Button>
    </div>
  );
}

// a one-line outcome under a row once an action finishes
// step: the next thing to do when it didn't work (Try again, Connect, Open approvals, Ask Unit7 why), from said()
export function Outcome({ tone, children, step }: { tone: 'ok' | 'bad' | 'info'; children: ReactNode; step?: ToastAction }) {
  return (
    <p role="status" className={cx('animate-pop mt-2 rounded-[14px] px-3 py-2 text-[12.5px]', tone === 'ok' ? 'bg-ok/10 text-ok' : tone === 'bad' ? 'bg-bad/8 text-bad' : 'bg-blue-soft text-blue-text')}>
      {children}
      {step && <button type="button" onClick={() => void step.onClick()} className="ml-2 font-semibold underline underline-offset-2 hover:no-underline">{step.label}</button>}
    </p>
  );
}

// what a tool call came back with, as one plain outcome
export function said(r: ToolResult | undefined, ok: string, o: { input?: unknown; retry?: () => unknown } = {}): { tone: 'ok' | 'bad' | 'info'; text: string; step?: ToastAction } {
  if (!r) return { tone: 'bad', text: 'That didn’t go through. Try again.' };
  if (r.status === 'ok') return { tone: 'ok', text: ok };
  if (r.status === 'approval_required') return { tone: 'info', text: `Waiting for your OK on Approvals. ${r.why}`, step: stepAction(r) };
  if (r.status === 'denied') return { tone: 'bad', text: `Not allowed: ${r.why}` };
  if (r.status === 'error') return { tone: 'bad', text: r.error.message, step: stepAction(r, o) };
  return { tone: 'info', text: 'Previewed only.' };
}
export async function call(name: string, input: unknown) {
  try { return await runTool(name, input); } catch (e) { return { status: 'error', error: { code: 'network', message: (e as Error).message } } as ToolResult; }
}

// put a request in the ask box: right here on Home, or go Home first
export function ask(text: string) {
  if (location.pathname === '/') fillAsk(text); else askOnHome(text);
}
export const openMap = (id: string) => navigate(`/map?open=${encodeURIComponent(id)}`);

// tool.progress lines for these tools while `on` (one tool at a time per kind; ponytail: two deploys
// running at once interleave their lines here; a deploy id on the event would split them)
export function useProgress(tools: string[], on: boolean) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!on) return;
    return onLive((e) => { if (e.type === 'tool.progress' && tools.includes(e.data?.tool)) setLines((l) => [...l.slice(-199), e.message]); });
  }, [on, tools.join()]);
  return lines;
}

// a ticking "1m 12s" while something runs
export function useElapsed(on: boolean) {
  const [t0] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => { if (!on) return; const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i); }, [on]);
  return Math.round((Date.now() - t0) / 1000);
}
