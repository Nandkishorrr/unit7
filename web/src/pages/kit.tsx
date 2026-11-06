// Pieces shared by the Projects, Servers and app pages: logos for a stack, plain-word states,
// the "…" menu, a dark log panel and the rounded bar chart.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { placeCard } from '../lib/place';
import { MoreHorizontal } from 'lucide-react';
import { BrandLogo } from '../brand/BrandLogo';
import { A, cx, Badge, timeAgo } from '../ui';

// --- what a service is, in logos and words ---
const DB = new Set(['postgres', 'mysql', 'mariadb', 'redis', 'mongo']);
export const isDb = (kind: string) => DB.has(kind);
// detected stacks whose logo goes by another name; the rest are their own logo id
const STACK: Record<string, string> = { next: 'nextjs', express: 'node', nest: 'node', nestjs: 'node', static: 'caddy', flask: 'python', fastapi: 'python', golang: 'go', mongo: 'mongodb' };
export function stackLogo(s: { kind: string; stack?: string | null; config?: any }): string {
  if (isDb(s.kind)) return s.kind === 'mariadb' ? 'mysql' : s.kind === 'mongo' ? 'mongodb' : s.kind;
  const st = s.stack ?? s.config?.detection?.stack ?? s.config?.detection?.runtime;
  if (st) return STACK[st] ?? st;
  return s.config?.nodeVersion ? 'node' : 'docker';
}
export const kindWord = (kind: string) => (isDb(kind) ? 'Database' : kind === 'worker' ? 'Background worker' : 'App');

export type Tone = 'ok' | 'bad' | 'work' | 'warn' | 'idle';
export function svcState(s: { status: string; kind: string }): { tone: Tone; word: string } {
  const st = s.status ?? 'new';
  if (st === 'healthy' || st === 'running') return { tone: 'ok', word: isDb(s.kind) ? 'Running' : 'Live' };
  if (st === 'unhealthy' || st === 'failed') return { tone: 'bad', word: 'Needs a look' };
  if (st === 'down') return { tone: 'bad', word: 'Down' };
  if (st === 'deploying' || st === 'building') return { tone: 'work', word: 'Deploying' };
  if (st === 'stopped') return { tone: 'idle', word: 'Stopped' };
  if (st === 'new') return { tone: 'idle', word: 'Not live yet' };
  return { tone: 'idle', word: st.charAt(0).toUpperCase() + st.slice(1) };
}
export const BADGE_TONE = { ok: 'ok', bad: 'bad', work: 'info', warn: 'warn', idle: 'neutral' } as const;
export const StateBadge = ({ s }: { s: { status: string; kind: string } }) => {
  const st = svcState(s);
  return <Badge tone={BADGE_TONE[st.tone]} solid={st.tone === 'ok' || st.tone === 'bad'}>{st.tone === 'work' && <span className="size-1.5 animate-working rounded-full bg-current" />}{st.word}</Badge>;
};

// --- environments ---
const ENV_RANK: Record<string, number> = { production: 0, staging: 1, development: 2 };
export const sortEnvs = <T extends { kind: string }>(envs: T[]) => [...envs].sort((a, b) => (ENV_RANK[a.kind] ?? 3) - (ENV_RANK[b.kind] ?? 3));
export const envLabel = (e: { kind: string; name: string }) => (e.kind === 'development' ? 'Dev' : e.name);
export function envHealth(e: { services: any[] }): Tone {
  const states = e.services.map((s) => svcState(s).tone);
  if (states.includes('bad') || e.services.some((s) => (s.domains ?? []).some((d: any) => d.status === 'broken'))) return 'bad';
  if (states.includes('work')) return 'work';
  return states.includes('ok') ? 'ok' : 'idle';
}

// --- addresses ---
export const urlOf = (d: { hostname: string; tls?: string }) => `${d.tls === 'off' ? 'http' : 'https'}://${d.hostname}`;
export const DNS = ['cloudflare', 'hostinger', 'godaddy', 'porkbun', 'namecom', 'namecheap', 'squarespace'];
export const dnsOf = (env?: { accounts?: { provider: string }[] }) => env?.accounts?.find((a) => DNS.includes(a.provider))?.provider;
export const isInstant = (host: string) => /\.(sslip|nip)\.io$/.test(host);
// the address people should use: a working custom domain first, the instant one last
export function mainDomain(services: any[]) {
  const ds = services.filter((s) => !isDb(s.kind)).flatMap((s) => s.domains ?? []);
  return ds.find((d) => !isInstant(d.hostname) && d.status === 'active') ?? ds.find((d) => !isInstant(d.hostname)) ?? ds[0];
}

// SSH problems say the same thing in plain words
export const reach = (msg: string, server = 'the server') =>
  /ssh|ECONN|EHOSTUNREACH|timed? ?out|host key|handshake/i.test(msg) ? `Unit7 can’t reach ${server} right now.` : msg;

// "4d ago" for a month, then "29 Sep" (with the year only when it isn't this year)
export const ago = timeAgo; // one date style everywhere: "4d ago", then "29 Sep"

export const deployTime = (d: { finished_at?: string | null; started_at?: string | null } | null | undefined) => (d ? new Date(d.finished_at ?? d.started_at ?? 0).getTime() : 0);
export function since(iso: string | null | undefined) {
  if (!iso) return null;
  const m = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

// a brand logo on a soft rounded square
export function LogoTile({ id, size = 44, className, children }: { id?: string; size?: number; className?: string; children?: ReactNode }) {
  return (
    <span className={cx('grid shrink-0 place-items-center bg-raised text-ink', className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.32) }}>
      {children || (id && <BrandLogo id={id} size={Math.round(size * 0.52)} />)}
    </span>
  );
}

// --- the "…" menu ---
// It opens in the top layer (a popover, placed under its button, or above it when there's no room), so no card,
// scroll box or pop-up around the button can cover or clip it. Esc, a press elsewhere or a scroll closes it.
export type MenuItem = { label: string; icon?: ReactNode; onSelect?: () => void; href?: string; hint?: string; danger?: boolean; disabled?: boolean } | { section: string };
export function Menu({ label, items, children, className, align = 'right' }: { label: string; items: MenuItem[]; children?: ReactNode; className?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = list.current, b = btn.current;
    if (!open || !el || !b) return;
    try { el.showPopover?.(); } catch { /* no top layer here: it stays a fixed layer */ }
    const r = b.getBoundingClientRect(), w = el.offsetWidth;
    const p = placeCard({ left: align === 'right' ? r.right - w : r.left, top: r.top, width: w, height: r.height }, { width: w, height: el.offsetHeight }, { width: innerWidth, height: innerHeight });
    el.style.left = `${p.left}px`; el.style.top = `${p.top}px`;
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled=true])')?.focus();
    const inside = (n: EventTarget | null) => !!n && (!!box.current?.contains(n as Node) || !!list.current?.contains(n as Node));
    const away = (e: MouseEvent) => { if (!inside(e.target)) setOpen(false); };
    const scrolled = (e: Event) => { if (!inside(e.target)) setOpen(false); };
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); return; } // not the pop-up under it too
      if (e.key === 'Tab') { setOpen(false); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const all = [...(list.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([aria-disabled=true])') ?? [])];
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', keys, true);
    document.addEventListener('scroll', scrolled, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', keys, true); document.removeEventListener('scroll', scrolled, true); };
  }, [open]);
  const row = 'flex w-full items-start gap-3 rounded-[14px] px-3 py-2.5 text-left text-[13.5px] transition outline-none focus-visible:bg-raised';
  const host = open ? box.current?.closest('dialog') ?? document.body : null; // inside a pop-up, so it isn't inert
  return (
    <div ref={box} className="relative">
      <button ref={btn} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={className ?? cx('grid size-10 place-items-center rounded-full border border-line-strong bg-surface text-ink transition hover:bg-raised', open && 'bg-raised')}>
        {children ?? <MoreHorizontal size={18} />}
      </button>
      {open && host && createPortal(
        <div ref={list} popover="manual" role="menu" aria-label={label} className={cx('animate-pop fixed inset-auto m-0 max-h-[min(70vh,520px)] w-[268px] overflow-y-auto rounded-[22px] border border-line bg-surface p-1.5 text-ink shadow-float', align === 'right' ? 'origin-top-right' : 'origin-top-left')}>
          {items.map((it, i) => {
            if ('section' in it) return <p key={i} className={cx('px-3 pb-1 pt-2 text-[11.5px] font-medium text-faint', i > 0 && 'mt-1 border-t border-line pt-2.5')}>{it.section}</p>;
            const body = (
              <>
                {it.icon && <span className="mt-0.5 shrink-0">{it.icon}</span>}
                <span className="min-w-0 flex-1"><span className="block font-medium">{it.label}</span>{it.hint && <span className="block text-[12px] font-normal text-muted">{it.hint}</span>}</span>
              </>
            );
            const tone = it.disabled ? 'cursor-not-allowed text-faint' : it.danger ? 'text-bad hover:bg-bad/8 focus-visible:bg-bad/8' : 'text-ink-2 hover:bg-raised hover:text-ink';
            const done = () => setOpen(false);
            return it.href
              ? <A key={i} role="menuitem" href={it.href} onClick={done} className={cx(row, tone)}>{body}</A>
              : <button key={i} type="button" role="menuitem" aria-disabled={it.disabled || undefined} onClick={() => { if (it.disabled) return; done(); it.onSelect?.(); }} className={cx(row, tone)}>{body}</button>;
          })}
        </div>, host)}
    </div>
  );
}

// --- a dark log panel. Errors read red, good news lime; keeps itself scrolled to the end ---
export function Terminal({ lines, loading, empty = 'Nothing here yet.', className }: { lines: string[] | null; loading?: boolean; empty?: string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [lines]);
  const tint = (l: string) => (/\b(error|failed|fatal|refused|exception|panic)\b/i.test(l) ? 'text-[#ff8a80]' : /\b(warn|warning)\b/i.test(l) ? 'text-[#fcd34d]' : /\b(healthy|live|ready|success|done)\b/i.test(l) ? 'text-lime' : 'text-white/80');
  return (
    <pre ref={ref} tabIndex={0} aria-label="Log output" aria-busy={loading || undefined}
      className={cx('max-h-[440px] min-h-[220px] overflow-auto rounded-[18px] bg-black/40 p-4 font-mono text-[12px] leading-[1.7] ring-1 ring-white/5 transition-opacity focus-visible:outline-lime', loading && 'opacity-60', className)}>
      {!lines ? <span className="text-white/50">Loading…</span> : !lines.length ? <span className="text-white/50">{empty}</span> : lines.map((l, i) => (
        <span key={i} className="flex gap-4"><span aria-hidden className="w-7 shrink-0 select-none text-right text-white/25">{i + 1}</span><span className={cx('whitespace-pre-wrap break-all', tint(l))}>{l}</span></span>
      ))}
    </pre>
  );
}
// the dark card the terminal sits in
export function DarkCard({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return <section id={id} className={cx('rounded-[24px] bg-[#111115] p-5 text-white shadow-soft ring-1 ring-white/5 md:p-6 dark:bg-[#202029] dark:ring-white/12 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]', className)}>{children}</section>;
}
export function DarkChip({ on, children, onClick }: { on?: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={cx('inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition focus-visible:outline-lime', on ? 'bg-white text-[#111115]' : 'bg-white/8 text-white/75 hover:bg-white/14 hover:text-white')}>
      {children}
    </button>
  );
}

// --- the reference's bar chart: soft rounded bars, the one you point at in blue with a dark
// tooltip and a dashed line at its height; hatched bars where there's no number ---
export interface BarPoint { label: string; value: number | null; tip?: ReactNode }
export function BarChart({ points, max = 100, height = 200, empty, unit = '%', name }: { points: BarPoint[]; max?: number; height?: number; empty?: ReactNode; unit?: string; name: string }) {
  const last = points.map((p) => p.value != null).lastIndexOf(true);
  const [hover, setHover] = useState<number | null>(null);
  const active = hover ?? (last === -1 ? null : last);
  const pct = (v: number) => 14 + (Math.min(v, max) / max) * 86;
  const a = active != null ? points[active] : undefined;
  const every = Math.ceil(points.length / 7);
  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <div className="relative" style={{ height }}>
        {a?.value != null && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-dashed border-line-strong transition-[bottom] duration-300" style={{ bottom: `${pct(a.value)}%` }}>
            <span className="absolute -top-5 left-0 text-[11px] text-muted">{Math.round(a.value)}{unit}</span>
          </div>
        )}
        <div className="grid h-full items-end gap-1.5 sm:gap-2.5" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
          {points.map((p, i) => {
            const on = i === active && p.value != null;
            return (
              <div key={i} className="relative flex h-full items-end justify-center">
                {on && p.tip && (
                  <div role="tooltip" className={cx('animate-pop absolute z-10 w-max min-w-[140px] rounded-[16px] bg-[#111115] p-3 text-[12px] text-white shadow-float ring-1 ring-white/10',
                    i < 2 ? 'left-0' : i > points.length - 3 ? 'right-0' : 'left-1/2 -translate-x-1/2')} style={{ bottom: `calc(${pct(p.value!)}% + 10px)` }}>
                    <p className="mb-2 inline-block rounded-full bg-white/12 px-2 py-0.5 text-[11px]">{p.label}</p>
                    {p.tip}
                  </div>
                )}
                {p.value == null ? <span aria-hidden className="hatch block h-full w-full max-w-[56px] rounded-[12px] bg-raised/70 sm:rounded-[16px]" /> : (
                  <button type="button" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                    aria-label={`${name}, ${p.label}: ${Math.round(p.value)}${unit}`}
                    className={cx('animate-grow block w-full max-w-[56px] rounded-[12px] transition-colors sm:rounded-[16px]', on ? 'bg-blue' : 'bg-raised hover:bg-sunken')}
                    style={{ height: `${pct(p.value)}%`, animationDelay: `${120 + i * 40}ms` }} />
                )}
              </div>
            );
          })}
        </div>
        {last === -1 && empty && <div className="absolute inset-0 grid place-items-center p-4"><div className="max-w-[320px] rounded-[18px] bg-surface/95 px-4 py-3 text-center text-[13px] text-muted shadow-soft ring-1 ring-line">{empty}</div></div>}
      </div>
      <div className="mt-2.5 grid gap-1.5 sm:gap-2.5" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
        {points.map((p, i) => <span key={i} className={cx('whitespace-nowrap text-center text-[11px] sm:text-[11.5px]', i === active ? 'font-medium text-ink' : 'text-muted')}>{(i % every === (points.length - 1) % every) ? p.label : ''}</span>)}
      </div>
    </div>
  );
}

// a server's last hour as 12 five-minute bars, from server.metrics history
export function hourBars(history: { at: string; cpu: number | null; mem_used: number | null; mem_total: number | null }[] | null, metric: 'cpu' | 'mem'): BarPoint[] {
  const now = Date.now();
  return Array.from({ length: 12 }, (_, i) => {
    const end = now - (11 - i) * 300_000, start = end - 300_000;
    const rows = (history ?? []).filter((r) => { const t = new Date(r.at).getTime(); return t > start && t <= end; });
    const avg = (f: (r: (typeof rows)[number]) => number | null) => { const v = rows.map(f).filter((x): x is number => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const cpu = avg((r) => r.cpu), mem = avg((r) => (r.mem_total ? ((r.mem_used ?? 0) / r.mem_total) * 100 : null));
    const value = metric === 'cpu' ? cpu : mem;
    const label = i === 11 ? 'Now' : new Date(end).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return {
      label, value,
      tip: (
        <>
          <p className="flex items-center gap-2"><span className="size-2 rounded-full bg-blue" />CPU<span className="tabular ml-auto pl-4 font-medium">{cpu == null ? '–' : `${Math.round(cpu)}%`}</span></p>
          <p className="mt-1 flex items-center gap-2"><span className="size-2 rounded-full bg-lime" />Memory<span className="tabular ml-auto pl-4 font-medium">{mem == null ? '–' : `${Math.round(mem)}%`}</span></p>
        </>
      ),
    };
  });
}
