// Unit7's component kit. Small on purpose: every piece is used on more than one page.
import { createElement, forwardRef, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type AnchorHTMLAttributes, type CSSProperties } from 'react';
import { Check, Copy, Loader2, X, AlertTriangle, CircleCheck, Info, ShieldAlert, ChevronDown, ArrowUpRight, Search, Clock } from 'lucide-react';
import { navigate, onLinkClick } from './lib/router';
import { runTool, type ToolResult } from './lib/api';
import { createPortal } from 'react-dom';
import { placeCard } from './lib/place';
import { nextStep } from './lib/nextstep';
import { errorChoices } from './lib/choices';
import { plainError, rawWords, toastBody } from './lib/words';
import { useId } from 'react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// --- buttons & inputs ---
// primary = blue (the thing to do), dark = black (strong second), soft = light grey, secondary = white outline
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'dark' | 'soft' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: ReactNode };
export const Button = forwardRef<HTMLButtonElement, BtnProps>(({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) => (
  <button
    ref={ref}
    disabled={disabled || loading}
    className={cx(
      'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-[background,border,color,box-shadow,transform] duration-150 select-none whitespace-nowrap active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none [&_svg]:shrink-0',
      size === 'sm' ? 'h-8 px-3.5 text-[12.5px]' : size === 'lg' ? 'h-12 px-6 text-[14.5px]' : 'h-10 px-4.5 text-[13.5px]',
      variant === 'primary' && 'bg-blue text-white hover:brightness-110',
      variant === 'dark' && 'bg-ink text-bg hover:opacity-90',
      variant === 'soft' && 'bg-raised text-ink hover:bg-sunken',
      variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:bg-raised',
      variant === 'ghost' && 'text-ink-2 hover:bg-raised hover:text-ink',
      variant === 'danger' && 'bg-bad-solid text-white hover:brightness-110',
      className,
    )}
    {...rest}
  >
    {loading ? <Loader2 size={15} className="animate-spin" /> : icon}
    {children}
  </button>
));

const field = 'w-full rounded-[14px] border border-line-strong bg-surface text-[14px] text-ink placeholder:text-faint outline-none transition focus:border-blue focus:ring-4 focus:ring-blue-soft focus-visible:outline-none';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input ref={ref} className={cx('h-10 px-3.5', field, className)} {...rest} />
));

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...rest }, ref) => (
  <textarea ref={ref} className={cx('px-3.5 py-2.5', field, className)} {...rest} />
));

export function Select({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <span className={cx('relative inline-flex', className)}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={cx('h-10 appearance-none pl-3.5 pr-9', field)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown size={15} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
    </span>
  );
}

// A pill dropdown, like "This week ⌄" in a card header. A real <select> underneath.
export function ChipSelect({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label: string }) {
  return (
    <span className="relative inline-flex">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}
        className="h-8 appearance-none rounded-full border border-line-strong bg-surface pl-3 pr-8 text-[12.5px] font-medium text-ink outline-none transition hover:bg-raised focus-visible:ring-4 focus-visible:ring-blue-soft">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown size={14} aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" />
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="block text-[12.5px] text-muted">{hint}</span>}
    </label>
  );
}

export function A({ href, children, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a href={href} {...rest} onClick={(e) => { onClick?.(e); onLinkClick(e); }}>{children}</a>;
}

// --- surfaces ---
export function Card({ className, children, lift }: { className?: string; children: ReactNode; lift?: boolean }) {
  return <div className={cx('rounded-[24px] border border-line bg-surface shadow-soft', lift && 'lift', className)}>{children}</div>;
}

const CIRCLE = {
  neutral: 'bg-raised text-ink', blue: 'bg-blue text-white', soft: 'bg-blue-soft text-blue-text', lime: 'bg-lime text-lime-ink',
  ok: 'bg-ok-solid text-white', bad: 'bg-bad-solid text-white', warn: 'bg-[#f59e0b] text-[#1f1300]', dark: 'bg-ink text-bg', glass: 'bg-white/10 text-white',
  grad: 'icon-grad', // a soft blue → violet → lime gradient (the look is .icon-grad in styles.css)
} as const;
export function IconCircle({ tone = 'neutral', size = 44, children, className }: { tone?: keyof typeof CIRCLE; size?: number; children: ReactNode; className?: string }) {
  return <span aria-hidden className={cx('grid shrink-0 place-items-center rounded-full', CIRCLE[tone], className)} style={{ width: size, height: size }}>{children}</span>;
}

// round "open this" button in a card corner
export function ArrowLink({ href, label, className, onDark }: { href: string; label: string; className?: string; onDark?: boolean }) {
  return (
    <A href={href} aria-label={label} title={label}
      className={cx('grid size-9 shrink-0 place-items-center rounded-full border transition',
        onDark ? 'border-white/20 text-white hover:border-white hover:bg-white hover:text-[#111115]' : 'border-line-strong text-ink hover:border-ink hover:bg-ink hover:text-bg', className)}>
      <ArrowUpRight size={16} />
    </A>
  );
}

// icon circle + title on the left; chips and the open arrow on the right
export function CardHeader({ icon, tone, title, sub, href, actions, className }: { icon?: ReactNode; tone?: keyof typeof CIRCLE; title: ReactNode; sub?: ReactNode; href?: string; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-center gap-3', className)}>
      {icon && <IconCircle tone={tone}>{icon}</IconCircle>}
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[16.5px] font-medium tracking-[-0.015em] text-ink">{href ? <A href={href} className="hover:underline decoration-line-strong underline-offset-4">{title}</A> : title}</h2>
        {sub && <p className="truncate text-[12.5px] text-muted">{sub}</p>}
      </div>
      {actions}
      {href && <ArrowLink href={href} label={`Open ${typeof title === 'string' ? title : 'this'}`} />}
    </div>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-[12.5px] font-medium text-ink-2', className)}>{children}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    // relative z-20: a menu in the actions (the client filter, a "…") opens over the cards below, not under them
    <div className="relative z-20 mb-8 flex flex-wrap items-end justify-between gap-4 animate-rise">
      <div className="min-w-0">
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.035em] text-ink md:text-[32px]">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-[14px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('space-y-3.5', className)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15.5px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

const DOT = { ok: 'bg-ok', warn: 'bg-[#f59e0b]', bad: 'bg-bad', info: 'bg-blue', idle: 'bg-faint/60', work: 'bg-blue' } as const;
export function Dot({ tone = 'idle', working }: { tone?: keyof typeof DOT; working?: boolean }) {
  return <span className={cx('inline-block size-2 shrink-0 rounded-full', DOT[tone], working && 'animate-working')} />;
}

const BADGE = {
  neutral: 'bg-raised text-ink-2', ember: 'bg-blue-soft text-blue-text', info: 'bg-blue-soft text-blue-text', lime: 'bg-lime text-lime-ink', dark: 'bg-ink text-bg',
  ok: 'bg-ok/12 text-ok', warn: 'bg-warn/12 text-warn', bad: 'bg-bad/10 text-bad',
} as const;
const SOLID: Partial<Record<keyof typeof BADGE, string>> = { ok: 'bg-ok-solid text-white', bad: 'bg-bad-solid text-white', warn: 'bg-[#f59e0b] text-[#1f1300]', ember: 'bg-blue text-white', info: 'bg-blue text-white', neutral: 'bg-ink text-bg' };
export function Badge({ tone = 'neutral', solid, children, className }: { tone?: keyof typeof BADGE; solid?: boolean; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium', (solid && SOLID[tone]) || BADGE[tone], className)}>{children}</span>;
}

export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line-strong bg-raised px-1 font-sans text-[11px] text-muted">{children}</kbd>
);

export function Empty({ icon, art, title, body, action }: { icon?: ReactNode; art?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="illo-host flex flex-col items-center justify-center rounded-[24px] border border-dashed border-line-strong bg-surface/60 px-6 py-14 text-center animate-rise">
      {art ? <div className="mb-4">{art}</div> : icon && <IconCircle size={52} className="mb-4 text-muted">{icon}</IconCircle>}
      <p className="text-[15px] font-medium text-ink">{title}</p>
      {body && <p className="mt-1 max-w-md text-[13.5px] text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cx('skeleton', className)} />;

export function Rows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-line overflow-hidden rounded-[24px] border border-line bg-surface shadow-soft">{children}</div>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cx('font-mono text-[12.5px] text-ink-2', className)}>{children}</code>;
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? 'Copied' : 'Copy'}
      className={cx('inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-raised hover:text-ink', className)}
      onClick={() => { void navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); }}
    >
      {done ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
    </button>
  );
}

// A black pill that slides to whichever child has data-pill={active}. Used by the top nav and Tabs.
export function useSlidingPill<T extends HTMLElement>(active: string | null) {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<{ x: number; w: number; animate: boolean } | null>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const place = () => {
      const el = active == null ? null : root.querySelector<HTMLElement>(`[data-pill="${CSS.escape(active)}"]`);
      setBox((b) => (el ? { x: el.offsetLeft, w: el.offsetWidth, animate: !!b } : null));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(root);
    return () => ro.disconnect();
  }, [active]);
  const style: CSSProperties = box ? { transform: `translateX(${box.x}px)`, width: box.w, transition: box.animate ? undefined : 'none' } : { opacity: 0 };
  return [ref, style] as const;
}
export const PILL = 'pointer-events-none absolute inset-y-1 left-0 rounded-full bg-ink transition-[transform,width] duration-[380ms] ease-out-soft';

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[] }) {
  const [ref, pill] = useSlidingPill<HTMLDivElement>(value);
  const many = tabs.length >= 5; // on a phone five or more don't fit in a row: they sit three across instead of scrolling sideways
  return (
    <div className={cx('max-w-full', many ? 'max-sm:w-full sm:overflow-x-auto' : 'overflow-x-auto')}>
      <div ref={ref} role="tablist" className={cx('relative inline-flex gap-0.5 rounded-full border border-line bg-surface p-1 shadow-soft', many && 'max-sm:grid max-sm:w-full max-sm:grid-cols-3 max-sm:rounded-[22px]')}>
        <span aria-hidden className={cx(PILL, many && 'max-sm:hidden')} style={pill} />
        {tabs.map((t) => (
          <button
            key={t.value}
            data-pill={t.value}
            role="tab"
            aria-selected={value === t.value}
            onClick={() => onChange(t.value)}
            className={cx('relative z-10 inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full px-4 text-[13.5px] font-medium transition-colors duration-300', many && 'max-sm:h-auto max-sm:min-h-9 max-sm:justify-center max-sm:whitespace-normal max-sm:px-2 max-sm:py-1.5 max-sm:text-center max-sm:text-[13px] max-sm:leading-tight',
              value === t.value ? cx('text-bg', many && 'max-sm:bg-ink') : 'text-muted hover:text-ink')}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- dialog & drawer: the native element, so focus trapping and Escape come free ---
function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) {
      d.showModal();
      raiseToasts();
      // showModal focuses the close button; put the cursor in the first field instead
      requestAnimationFrame(() => d.querySelector<HTMLElement>('input:not([type=checkbox]), textarea, select')?.focus());
    }
    if (!open && d.open) d.close();
  }, [open]);
  return ref;
}

const CloseX = ({ onClose }: { onClose: () => void }) => (
  <button aria-label="Close" onClick={onClose} className="-mr-2 -mt-1 grid size-9 shrink-0 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink"><X size={17} /></button>
);

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useModal(open);
  return (
    <dialog
      ref={ref}
      onClose={(e) => { if (e.target === ref.current) onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={cx('m-auto w-[calc(100%-2rem)] rounded-[28px] border border-line bg-surface p-0 text-ink shadow-float', wide ? 'max-w-2xl' : 'max-w-md')}
    >
      {open && (
        <div className="p-6 sm:p-7">
          <div className="mb-5 flex items-start justify-between gap-4">
            <h2 className="text-[18px] font-semibold tracking-[-0.02em]">{title}</h2>
            <CloseX onClose={onClose} />
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

// The pop-up for everything a card opens: centred over a blurred backdrop, it scales up from 0.96 and fades in
// (a sheet with a handle that rises from the bottom on phones; a plain fade with reduced motion; the look is
// dialog.modal in styles.css). Esc, a click outside or the X close it; focus stays inside while it's open and goes
// back to whatever opened it. The title row stays put and long content scrolls under it.
// size: sm ≈ 420px, md ≈ 560px (default), lg ≈ 760px, xl ≈ 1040px for rich detail.
const MODAL_W = { sm: 'sm:max-w-[420px]', md: 'sm:max-w-[560px]', lg: 'sm:max-w-[760px]', xl: 'sm:max-w-[1040px]' } as const;
const MODAL_OUT_MS = 160;
export function Modal({ open, onClose, title, children, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; size?: keyof typeof MODAL_W }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const pressed = useRef(false); // the press began on the backdrop (a text drag that ends outside doesn't close it)
  const [closing, setClosing] = useState(false);
  const titleId = useId();
  // callers often clear their content the moment it closes: keep showing the last of it while it animates out
  const last = useRef({ title, children });
  if (open) last.current = { title, children };
  useEffect(() => {
    const d = ref.current!;
    if (open) {
      setClosing(false);
      if (!d.open) {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        d.showModal();
        raiseToasts();
        // showModal focuses the close button; put the cursor in the first field instead
        requestAnimationFrame(() => d.querySelector<HTMLElement>('[autofocus], input:not([type=checkbox]), textarea, select')?.focus());
      }
      return;
    }
    if (!d.open) return;
    setClosing(true);
    const t = setTimeout(() => {
      d.close();
      setClosing(false);
      const o = opener.current;
      opener.current = null;
      if (o?.isConnected) o.focus({ preventScroll: true });
    }, MODAL_OUT_MS);
    return () => clearTimeout(t);
  }, [open]);
  const shown = open || closing || !!ref.current?.open;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => { if (e.target !== ref.current) return; e.preventDefault(); onClose(); }} // Esc: animate out like any other close. React bubbles these, so a dialog inside this one stays its own
      onClose={(e) => { if (open && e.target === ref.current) onClose(); }} // the browser closed it on its own
      onPointerDown={(e) => { pressed.current = e.target === ref.current; }}
      onClick={(e) => { if (pressed.current && e.target === ref.current) onClose(); pressed.current = false; }}
      className={cx('modal m-auto max-h-[calc(100dvh-3rem)] w-[calc(100%-2rem)] overflow-hidden rounded-[28px] border border-line bg-surface p-0 text-ink shadow-float',
        'max-sm:mx-0 max-sm:mb-0 max-sm:max-h-[92dvh] max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none', MODAL_W[size], closing && 'closing')}
    >
      {shown && (
        <div className="flex max-h-[inherit] flex-col">
          <span aria-hidden className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-line-strong sm:hidden" />
          <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-4 pt-4 sm:pt-6">
            <h2 id={titleId} className="min-w-0 text-[18px] font-semibold tracking-[-0.02em]">{last.current.title}</h2>
            <CloseX onClose={onClose} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6">{last.current.children}</div>
        </div>
      )}
    </dialog>
  );
}
// the old name: every page that opened a side drawer now gets the centred pop-up
export const Drawer = Modal;

// --- hover card: a small card of details over its trigger ------------------------------------------------------------
// <HoverCard content={…}>{trigger}</HoverCard>. Opens after the pointer rests on the trigger (delay, 250ms), on
// keyboard focus, or on a tap on touch screens (the first tap shows it, the next does what the trigger does). It stays
// open while the pointer moves onto it and closes on Esc, a press elsewhere or a scroll. It sits under its trigger
// (above when there's no room), kept inside the window, in the top layer so no card or pop-up clips it. The trigger
// should be an element (it's measured); as="g" for a trigger inside an SVG.
export function HoverCard({ content, children, delay = 250, className, as = 'span' }: { content: ReactNode; children: ReactNode; delay?: number; className?: string; as?: 'span' | 'g' }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLElement>(null); // or an SVG <g>: typed as HTMLElement for its pointer events
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const touch = useRef(false);
  const set = (on: boolean, ms = 0) => { clearTimeout(timer.current); if (ms) timer.current = setTimeout(() => setOpen(on), ms); else setOpen(on); };
  // native enter/leave: React's follow the component tree, which counts the card (in a portal) as inside the trigger
  useEffect(() => {
    const t = wrap.current!;
    const enter = (e: PointerEvent) => { if (e.pointerType !== 'touch') set(true, delay); };
    const leave = (e: PointerEvent) => { if (e.pointerType !== 'touch') set(false, 120); };
    t.addEventListener('pointerenter', enter); t.addEventListener('pointerleave', leave);
    return () => { clearTimeout(timer.current); t.removeEventListener('pointerenter', enter); t.removeEventListener('pointerleave', leave); };
  }, [delay]);
  useLayoutEffect(() => {
    const el = card.current, t = wrap.current;
    if (!open || !el || !t) return;
    try { el.showPopover?.(); } catch { /* no top layer here: it stays a fixed layer */ }
    const p = placeCard((as === 'g' ? t : t.firstElementChild ?? t).getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight }, { width: innerWidth, height: innerHeight });
    el.style.left = `${p.left}px`; el.style.top = `${p.top}px`; el.dataset.side = p.side;
    const stay = () => clearTimeout(timer.current);
    const leave = (e: PointerEvent) => { if (e.pointerType !== 'touch') set(false, 120); };
    const away = (e: Event) => { const n = e.target as Node; if (!el.contains(n) && !t.contains(n)) set(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); set(false); } }; // not the pop-up under it too
    el.addEventListener('pointerenter', stay); el.addEventListener('pointerleave', leave);
    document.addEventListener('pointerdown', away, true); document.addEventListener('scroll', away, true); document.addEventListener('keydown', esc, true);
    return () => {
      el.removeEventListener('pointerenter', stay); el.removeEventListener('pointerleave', leave);
      document.removeEventListener('pointerdown', away, true); document.removeEventListener('scroll', away, true); document.removeEventListener('keydown', esc, true);
    };
  }, [open, as]);
  const host = open ? wrap.current?.closest('dialog') ?? document.body : null; // inside a pop-up, so it isn't inert
  return createElement(as, {
    ref: wrap,
    className: as === 'span' ? 'contents' : undefined,
    onPointerDown: (e: React.PointerEvent) => { touch.current = e.pointerType === 'touch'; },
    onClickCapture: (e: React.MouseEvent) => { if (touch.current && !open && content) { e.preventDefault(); e.stopPropagation(); set(true); } touch.current = false; },
    onFocus: (e: React.FocusEvent) => { if ((e.target as Element).matches?.(':focus-visible')) set(true); },
    onBlur: (e: React.FocusEvent) => { const n = e.relatedTarget as Node | null; if (!n || (!card.current?.contains(n) && !wrap.current?.contains(n))) set(false); },
  }, children, host && content ? createPortal(
    <div ref={card} popover="manual" className={cx('hovercard fixed inset-auto m-0 w-max max-w-[min(320px,calc(100vw-16px))] overflow-visible rounded-[18px] border border-line bg-surface p-3.5 text-left text-[13px] text-ink shadow-float', className)}>
      {content}
    </div>, host) : null);
}

// --- numbers & meters ---
// counts up once when it first appears (straight to the value with reduced motion)
export function CountUp({ value, format = (n) => String(Math.round(n)), duration = 800 }: { value: number; format?: (n: number) => string; duration?: number }) {
  const [n, setN] = useState(() => (reducedMotion() ? value : 0));
  const done = useRef(false);
  useEffect(() => {
    if (done.current || reducedMotion()) { setN(value); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setN(value * (1 - (1 - p) ** 3));
      if (p < 1) raf = requestAnimationFrame(tick); else done.current = true;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span className="tabular">{format(n)}</span>;
}

// a row of little segments, filled up to value% (blue; amber from 70; red from 90)
export function Meter({ value, segments = 14, label }: { value: number; segments?: number; label: string }) {
  const v = Math.max(0, Math.min(100, value));
  const on = Math.round((v / 100) * segments);
  const color = v >= 90 ? 'bg-bad-solid' : v >= 70 ? 'bg-[#f59e0b]' : 'bg-blue';
  return (
    <div role="meter" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} className="flex h-2 gap-[3px]">
      {Array.from({ length: segments }, (_, i) => (
        <span key={i} className={cx('flex-1 rounded-full transition-colors duration-500', i < on ? color : 'bg-sunken')} style={{ transitionDelay: `${i * 25}ms` }} />
      ))}
    </div>
  );
}

// a half-ring gauge; value 0..1
export function Gauge({ value, size = 220, children, track = 'rgb(255 255 255 / 0.09)', color = 'var(--blue)' }: { value: number; size?: number; children?: ReactNode; track?: string; color?: string }) {
  const p = Math.max(0, Math.min(1, value));
  const a = Math.PI * (1 - p);
  const kx = 100 + 80 * Math.cos(a), ky = 100 - 80 * Math.sin(a);
  return (
    <div className="relative mx-auto" style={{ width: size, height: size * 0.6 }}>
      <svg viewBox="0 0 200 120" width={size} height={size * 0.6} aria-hidden>
        <path d="M20 100A80 80 0 0 1 180 100" fill="none" stroke={track} strokeWidth="20" strokeLinecap="round" />
        {p > 0 && <path d="M20 100A80 80 0 0 1 180 100" fill="none" stroke={color} strokeWidth="20" strokeLinecap="round" pathLength={100}
          strokeDasharray={`${p * 100} 100`} style={{ animation: 'gauge-in 1.1s var(--ease-out-soft) both' }} />}
        {p > 0 && <circle cx={kx} cy={ky} r="7" fill="#fff" stroke={color} strokeWidth="3" className="animate-pop" style={{ animationDelay: '0.9s' }} />}
      </svg>
      {children && <div className="absolute inset-x-0 bottom-0 text-center">{children}</div>}
    </div>
  );
}

// --- toasts: small dark cards at the top, out of the way of everything else ---
// A toast may offer the next step ("Undo", "Show it", "Open"). A thin line shows how long it stays; hovering or
// focusing it holds it there.
export interface ToastAction { label: string; onClick: () => unknown }
interface Toast { id: number; tone: 'ok' | 'bad' | 'warn' | 'info'; title: string; body?: string; action?: ToastAction; more?: ToastAction; ms: number; details?: string }
let toasts: Toast[] = [];
const toastSubs = new Set<() => void>();
let nextId = 1;
const dropToast = (id: number) => { toasts = toasts.filter((x) => x.id !== id); toastSubs.forEach((s) => s()); };
// more: a second choice, for the few errors with two ways forward (the two buttons sit under the words)
// details: the full text for "Show details" (a build log, a long error). A body is never more than two short lines: a
// long or many-line one (a raw log) becomes its one plain sentence (toastBody), and the rest moves under Show details.
export function toast(tone: Toast['tone'], title: string, body?: string, o: { action?: ToastAction; more?: ToastAction; ms?: number; details?: string } = {}) {
  const shaped = toastBody(body);
  const details = o.details ? [body, o.details].filter(Boolean).join('\n\n') : shaped.more;
  // a toast with a button stays a little longer, so there's time to press it
  const t = { id: nextId++, tone, title, body: shaped.line, details, action: o.action, more: o.action && o.more, ms: o.ms ?? (o.more ? 12000 : tone === 'bad' ? 9000 : o.action || details ? 7000 : 5000) };
  toasts = [...toasts, t];
  toastSubs.forEach((s) => s());
  return t.id;
}
// take a toast away early (its question was answered another way)
export const dismissToast = (id: number | undefined) => { if (id !== undefined) dropToast(id); };
// the toaster sits in the top layer, which stacks in opening order: a pop-up opened after a toast (even in the same
// render) would cover it, so every pop-up calls this right after it opens, and the toasts step back on top
let raiseToasts = () => {};
export function Toaster() {
  const list = useSyncExternalStore((cb) => { toastSubs.add(cb); return () => toastSubs.delete(cb); }, () => toasts);
  // a popover lives in the top layer, so toasts show above an open drawer or dialog instead of behind its
  // backdrop. The top layer stacks in opening order: with a modal open, re-open to land above it.
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el?.showPopover) return; // no popover support: it stays an ordinary fixed layer
    if (el.matches(':popover-open')) { if (!list.length || !document.querySelector('dialog:modal')) return; el.hidePopover(); }
    el.showPopover();
  }, [list]);
  useEffect(() => {
    raiseToasts = () => { const el = box.current; if (el?.showPopover && toasts.length && el.matches(':popover-open')) { el.hidePopover(); el.showPopover(); } };
    return () => { raiseToasts = () => {}; };
  }, []);
  const icon = {
    ok: <CircleCheck size={17} className="text-lime" />, bad: <AlertTriangle size={17} className="text-[#ff8a80]" />,
    warn: <ShieldAlert size={17} className="text-[#fcd34d]" />, info: <Info size={17} className="text-[#9db8ff]" />,
  };
  return (
    <>
      <div ref={box} popover="manual" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-auto top-3 z-[60] m-0 mx-auto flex h-auto w-[400px] max-w-[calc(100vw-1.5rem)] flex-col items-center gap-2 overflow-visible border-0 bg-transparent p-0">
        {list.map((t) => <ToastCard key={t.id} t={t} icon={icon[t.tone]} />)}
      </div>
      <DetailsHost />
    </>
  );
}

function ToastCard({ t, icon }: { t: Toast; icon: ReactNode }) {
  const [held, setHeld] = useState(false);
  const left = useRef(t.ms);
  useEffect(() => {
    if (held) return;
    const from = Date.now();
    const timer = setTimeout(() => dropToast(t.id), left.current);
    return () => { clearTimeout(timer); left.current -= Date.now() - from; };
  }, [held, t.id]);
  const hold = { onMouseEnter: () => setHeld(true), onMouseLeave: () => setHeld(false), onFocus: () => setHeld(true), onBlur: () => setHeld(false) };
  return (
    <div {...hold} className="animate-pop pointer-events-auto relative flex w-full gap-3 overflow-hidden rounded-[20px] bg-[#111115] px-4 py-3.5 text-white shadow-float ring-1 ring-white/10">
      <div className="mt-0.5">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium">{t.title}</p>
        {t.body && <p className="mt-0.5 line-clamp-2 break-words text-[12.5px] text-white/70">{t.body}</p>}
        {t.details && (
          <button type="button" onClick={() => { dropToast(t.id); showDetails(t.title, t.details!); }}
            className="mt-1 rounded text-[12px] font-medium text-white/85 underline decoration-white/30 underline-offset-2 transition hover:decoration-white focus-visible:outline-lime">Show details</button>
        )}
        {t.more && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {[t.action!, t.more].map((a, i) => (
              <button key={a.label} type="button" onClick={() => { dropToast(t.id); void a.onClick(); }}
                className={cx('rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition focus-visible:outline-lime', i === 0 ? 'bg-lime text-[#111115] hover:opacity-90' : 'bg-white/12 text-white hover:bg-white/20')}>{a.label}</button>
            ))}
          </div>
        )}
      </div>
      {t.action && !t.more && (
        <button type="button" onClick={() => { dropToast(t.id); void t.action!.onClick(); }}
          className="-my-1 shrink-0 self-center rounded-full bg-white/12 px-3 py-1.5 text-[12.5px] font-semibold text-lime transition hover:bg-white/20 focus-visible:outline-lime">{t.action.label}</button>
      )}
      <span aria-hidden className="toast-life absolute inset-x-0 bottom-0 h-[2px] origin-left bg-white/30" style={{ animationDuration: `${t.ms}ms`, animationPlayState: held ? 'paused' : 'running' }} />
    </div>
  );
}

// Run a tool from a button and say what happened in plain words.
// The success toast offers the next step: `open` (a page or link: "Show it", "Open"), or Undo when the tool says how
// to take it back (its result's `undo` recipe, or a server change's changeId). undo: false leaves Undo out.
export async function act(name: string, input: unknown, o: { success?: string; dryRun?: boolean; open?: { label: string; href: string }; undo?: false } = {}): Promise<ToolResult & { status: 'ok' } | undefined> {
  try {
    const r = await runTool(name, input, { dryRun: o.dryRun });
    if (r.status === 'ok') { if (o.success) toast('ok', o.success, undefined, { action: nextAction(r.output, o) }); return r; }
    const step = stepAction(r, { input, retry: () => act(name, input, o) });
    if (r.status === 'approval_required') toast('warn', 'Waiting for approval', r.why, { action: step });
    else if (r.status === 'denied') toast('bad', 'Not allowed', r.why);
    else if (r.status === 'error') toast('bad', 'That didn’t work', r.error.message, { action: step, more: step && moreChoices(r, { tool: name, input }), details: r.error.logTail });
  } catch (e) {
    toast('bad', 'That didn’t work', (e as Error).message, { action: { label: 'Try again', onClick: () => act(name, input, o) } });
  }
  return undefined;
}
export function nextAction(out: any, o: { open?: { label: string; href: string }; undo?: false } = {}): ToastAction | undefined {
  if (o.open) {
    const { label, href } = o.open;
    return { label, onClick: () => (/^https?:\/\//.test(href) ? window.open(href, '_blank', 'noopener') : href.startsWith('#') ? document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'center' }) : navigate(href)) };
  }
  if (o.undo === false || !out || typeof out !== 'object') return undefined;
  const u = out.undo;
  if (u && typeof u === 'object' && typeof u.tool === 'string') return { label: 'Undo', onClick: () => act(u.tool, u.input, { success: 'Undone', undo: false }) };
  if (typeof out.changeId === 'string' && typeof u === 'string') return { label: 'Undo', onClick: () => act('change.undo', { changeId: out.changeId }, { success: 'Undone', undo: false }) };
  // a first deploy has nothing to go back to, but it has its live link
  if (out.status === 'live' && typeof out.url === 'string' && /^https?:\/\//.test(out.url)) return { label: 'Open ↗', onClick: () => window.open(out.url, '_blank', 'noopener') };
  return undefined;
}

// The next step after something didn't work, as a toast's button (lib/nextstep.ts decides which): Try again (when the
// caller can retry), Connect / Reconnect / Give permission / Open approvals (a page), or Ask Unit7 why (Home's ask box).
export function stepAction(r: ToolResult, o: { input?: unknown; retry?: () => unknown; ask?: string } = {}): ToastAction | undefined {
  const s = nextStep(r, o.input);
  if (!s) return undefined;
  if (s.kind === 'retry') return o.retry && { label: s.label, onClick: o.retry };
  if (s.kind === 'ask') return askAction(o.ask ?? `This didn’t work: “${r.status === 'error' ? plainError(r.error.message).line : ''}”. Why, and how do I fix it?`);
  return s.href ? { label: s.label, onClick: () => navigate(s.href!) } : undefined;
}

// "More": an error with more than one way forward opens its full choice row (pages/choices), the recommended one first
export function moreChoices(r: ToolResult, o: { tool?: string; input?: unknown; title?: string } = {}): ToastAction | undefined {
  const choices = errorChoices(r, o);
  if (choices.length < 2) return undefined;
  return { label: 'More', onClick: () => import('./pages/choices').then((m) => m.openChoices({ title: o.title ?? 'That didn’t work', body: r.status === 'error' ? plainError(r.error.message).line : undefined, choices })) };
}

// "Ask Unit7 why": the sentence goes into Home's ask box (nothing runs until the person presses Enter)
export const askAction = (text: string, label = 'Ask Unit7 why'): ToastAction => ({ label, onClick: () => import('./pages/Help').then((m) => m.askOnHome(text)) });

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.round(s / 86400)}d ago`;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
}

// --- switches & search ---
// an on/off switch: a real button with role=switch, so Space and Enter work and readers say "on/off"
export function Switch({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; className?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-[26px] w-[44px] shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50',
        checked ? 'bg-blue' : 'bg-sunken ring-1 ring-inset ring-line-strong', className)}>
      <span aria-hidden className={cx('size-5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-out-soft', checked ? 'translate-x-[21px]' : 'translate-x-[3px]')} />
    </button>
  );
}

// a setting as one line: what it is, a short why, the switch on the right
export function SwitchRow({ title, body, checked, onChange, disabled, children }: { title: ReactNode; body?: ReactNode; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-ink">{title}</p>
        {body && <p className="mt-0.5 text-[13px] text-muted">{body}</p>}
        {children}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={typeof title === 'string' ? title : 'Turn on or off'} className="mt-0.5" />
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search', label = 'Search', className }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string; className?: string }) {
  return (
    <label className={cx('relative block', className)}>
      <span className="sr-only">{label}</span>
      <Search size={16} aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="h-10 w-full rounded-full border border-line-strong bg-surface pl-10 pr-4 text-[14px] text-ink outline-none transition placeholder:text-faint focus:border-blue focus:ring-4 focus:ring-blue-soft focus-visible:outline-none" />
    </label>
  );
}

// --- AI actions ---
// The button for anything the AI does for you ("Deep check with AI", "Ask Unit7 to fix it"): a gradient ring that
// turns slowly and a sparkle that twinkles, so it reads as special without shouting. strong: the filled one, for the
// main next step. The look is .ai-btn in styles.css; it holds still under reduced motion.
export const AiButton = forwardRef<HTMLButtonElement, Omit<BtnProps, 'variant'> & { strong?: boolean }>(({ strong, size = 'md', loading, icon, className, children, disabled, ...rest }, ref) => (
  <button
    ref={ref}
    disabled={disabled || loading}
    className={cx(
      'ai-btn inline-flex items-center justify-center gap-2 rounded-full font-medium select-none whitespace-nowrap active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none [&_svg]:shrink-0',
      strong && 'ai-btn-strong',
      size === 'sm' ? 'h-8 px-3.5 text-[12.5px]' : size === 'lg' ? 'h-12 px-6 text-[14.5px]' : 'h-10 px-4.5 text-[13.5px]',
      className,
    )}
    {...rest}
  >
    {loading ? <Loader2 size={15} className="animate-spin" /> : icon ?? <AiSparkle size={size === 'sm' ? 14 : size === 'lg' ? 18 : 16} />}
    {children}
  </button>
));

// Unit7's AI mark: a four-point sparkle and two small twins that twinkle (gradient; white inside a strong button)
export function AiSparkle({ size = 16, className, still }: { size?: number; className?: string; still?: boolean }) {
  const id = `aisp${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={cx('ai-spark', still && 'ai-still', className)}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" style={{ stopColor: 'var(--ai-1)' }} /><stop offset="0.6" style={{ stopColor: 'var(--ai-2)' }} /><stop offset="1" style={{ stopColor: 'var(--ai-3)' }} /></linearGradient>
      </defs>
      <path className="ai-spark-a" d="M10 3.5c.95 5 2.9 6.95 7.9 7.9-5 .95-6.95 2.9-7.9 7.9-.95-5-2.9-6.95-7.9-7.9 5-.95 6.95-2.9 7.9-7.9z" fill={`url(#${id})`} />
      <path className="ai-spark-b" d="M19 1.5c.4 2.1 1.2 2.9 3.3 3.3-2.1.4-2.9 1.2-3.3 3.3-.4-2.1-1.2-2.9-3.3-3.3 2.1-.4 2.9-1.2 3.3-3.3z" fill={`url(#${id})`} />
      <path className="ai-spark-c" d="M19.5 15.5c.27 1.4.8 1.93 2.2 2.2-1.4.27-1.93.8-2.2 2.2-.27-1.4-.8-1.93-2.2-2.2 1.4-.27 1.93-.8 2.2-2.2z" fill={`url(#${id})`} />
    </svg>
  );
}

// --- hold to confirm: the big red buttons ---------------------------------------------------------------------------
// Press and hold (pointer, Space or Enter) while a fill sweeps across; letting go early cancels. With reduced motion
// it's two clicks instead ("Click again to confirm"). The hint is read out through aria-describedby. Give it the action
// ("Pause everything"); it says "Hold to pause everything" where holding is how it works.
export function HoldButton({ onConfirm, children, icon, size = 'md', ms = 800, disabled, loading, className, fillClassName = 'bg-black/25' }: {
  onConfirm: () => unknown; children: ReactNode; icon?: ReactNode; size?: 'sm' | 'md' | 'lg'; ms?: number; disabled?: boolean; loading?: boolean; className?: string; fillClassName?: string;
}) {
  const [holding, setHolding] = useState(false);
  const [say, setSay] = useState<string | null>(null); // "Keep holding…", "Hold to confirm", "Click again to confirm"
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hintId = useId();
  const still = reducedMotion();
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (!say || holding) return; const t = setTimeout(() => setSay(null), 2500); return () => clearTimeout(t); }, [say, holding]);
  const off = disabled || loading;
  const start = () => {
    if (still || off || holding) return;
    setHolding(true); setSay('Keep holding…');
    timer.current = setTimeout(() => { timer.current = undefined; setHolding(false); setSay(null); void onConfirm(); }, ms);
  };
  const stop = () => { if (!timer.current) return; clearTimeout(timer.current); timer.current = undefined; setHolding(false); setSay('Hold to confirm'); };
  const isKey = (k: string) => k === ' ' || k === 'Enter';
  return (
    <button type="button" disabled={off} aria-describedby={hintId}
      onPointerDown={(e) => { if (e.button === 0) start(); }} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onKeyDown={(e) => { if (!still && isKey(e.key)) { e.preventDefault(); if (!e.repeat) start(); } }}
      onKeyUp={(e) => { if (!still && isKey(e.key)) stop(); }}
      onClick={() => { if (!still || off) return; if (say) { setSay(null); void onConfirm(); } else setSay('Click again to confirm'); }}
      onContextMenu={(e) => e.preventDefault()}
      className={cx('relative isolate inline-flex select-none items-center justify-center gap-2 overflow-hidden whitespace-nowrap rounded-full font-medium [-webkit-touch-callout:none] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
        size === 'sm' ? 'h-8 px-3.5 text-[12.5px]' : size === 'lg' ? 'h-12 px-6 text-[14.5px]' : 'h-10 px-4.5 text-[13.5px]',
        className ?? 'bg-bad-solid text-white hover:brightness-110')}>
      <span aria-hidden className={cx('absolute inset-0 -z-10 origin-left', fillClassName)}
        style={{ transform: `scaleX(${holding ? 1 : 0})`, transition: `transform ${holding ? ms : 220}ms ${holding ? 'linear' : 'ease-out'}` }} />
      {loading ? <Loader2 size={15} className="animate-spin" /> : icon}
      <span aria-live="polite">{say ?? (typeof children === 'string' && !still ? `Hold to ${children.charAt(0).toLowerCase()}${children.slice(1)}` : children)}</span>
      <span id={hintId} className="sr-only">{still ? 'Click twice to confirm.' : 'Press and hold for a moment to confirm.'}</span>
    </button>
  );
}

// --- how fresh a number is ------------------------------------------------------------------------------------------
// <Fresh at={iso} every={ms} /> is a stamp: grey "checked 2m ago", amber "11h old" once it's older than twice its
// schedule (`every`, how often it's normally checked). <Fresh at every>{value}</Fresh> wraps the value itself: drawn
// faded with a small clock when it comes from a stale check. Both update by themselves.
const short = (ms: number) => { const s = ms / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
export function freshness(at: string | number | null | undefined, every: number, label = 'checked', now = Date.now()) {
  if (at == null || at === '') return { stale: true, age: Infinity, text: `not ${label} yet` };
  const age = now - new Date(at).getTime();
  const stale = age > 2 * every;
  return { stale, age, text: stale ? `${short(age)} old` : age < 45_000 ? `${label} just now` : `${label} ${short(age)} ago` };
}
const tickSubs = new Set<() => void>();
let tick = Date.now();
setInterval(() => { tick = Date.now(); tickSubs.forEach((s) => s()); }, 30_000);
export function Fresh({ at, every, label, className, children }: { at?: string | number | null; every: number; label?: string; className?: string; children?: ReactNode }) {
  useSyncExternalStore((cb) => { tickSubs.add(cb); return () => tickSubs.delete(cb); }, () => tick); // re-render every 30s
  const f = freshness(at, every, label);
  const when = at != null && at !== '' ? new Date(at).toLocaleString() : undefined;
  if (children !== undefined) {
    return <span className={cx('transition-opacity', f.stale && 'opacity-55', className)} title={f.stale ? `From a check ${f.text.replace(/ old$/, ' ago')}${when ? ` (${when})` : ''}` : when}>{children}{f.stale && <Clock size={12} aria-label=", from an old check" className="ml-1 inline align-[-1px]" />}</span>;
  }
  return <span className={cx('inline-flex items-center gap-1 text-[12px] tabular', f.stale ? 'text-warn' : 'text-faint', className)} title={when}>{f.stale && <Clock size={12} aria-hidden />}{f.text}</span>;
}

// --- small styled questions, instead of the browser's prompt() and confirm() ----------------------------------------
// promptDialog / confirmDialog return a promise; <Prompts /> (mounted once in App) shows them.
export interface PromptOptions { title: string; label: string; value?: string; placeholder?: string; hint?: string; confirm?: string; warn?: (v: string) => string | undefined }
export interface ConfirmOptions { title: string; body?: string; items?: string[]; warning?: string; confirm: string; cancel?: string; danger?: boolean }
type Asking = { kind: 'prompt'; o: PromptOptions; done: (v: string | null) => void } | { kind: 'confirm'; o: ConfirmOptions; done: (v: boolean) => void };
let asking: Asking | null = null;
const askSubs = new Set<() => void>();
const setAsking = (a: Asking | null) => {
  if (asking && asking !== a) { if (asking.kind === 'prompt') asking.done(null); else asking.done(false); }
  asking = a; askSubs.forEach((s) => s());
};
export const promptDialog = (o: PromptOptions) => new Promise<string | null>((done) => setAsking({ kind: 'prompt', o, done }));
export const confirmDialog = (o: ConfirmOptions) => new Promise<boolean>((done) => setAsking({ kind: 'confirm', o, done }));
export function Prompts() {
  const a = useSyncExternalStore((cb) => { askSubs.add(cb); return () => askSubs.delete(cb); }, () => asking);
  const [v, setV] = useState('');
  useEffect(() => { if (a?.kind === 'prompt') setV(a.o.value ?? ''); }, [a]);
  const finish = (yes: boolean) => {
    if (!a) return;
    asking = null; askSubs.forEach((s) => s());
    if (a.kind === 'prompt') a.done(yes && v.trim() ? v.trim() : null); else a.done(yes);
  };
  const warn = a?.kind === 'prompt' ? a.o.warn?.(v.trim()) : undefined;
  return (
    <Dialog open={!!a} onClose={() => finish(false)} title={a?.o.title ?? ''}>
      {a?.kind === 'prompt' && (
        <form onSubmit={(e) => { e.preventDefault(); finish(true); }} className="space-y-4">
          <Field label={a.o.label} hint={a.o.hint}><Input value={v} onChange={(e) => setV(e.target.value)} placeholder={a.o.placeholder} autoComplete="off" /></Field>
          {warn && <p role="status" className="flex items-start gap-2 rounded-[14px] bg-warn/10 px-3.5 py-2.5 text-[13px] text-ink-2"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />{warn}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => finish(false)}>Cancel</Button><Button variant="primary" disabled={!v.trim()}>{a.o.confirm ?? 'Save'}</Button></div>
        </form>
      )}
      {a?.kind === 'confirm' && (
        <div className="space-y-4">
          {a.o.body && <p className="text-[14px] text-ink-2">{a.o.body}</p>}
          {!!a.o.items?.length && <ul className="space-y-1.5">{a.o.items.map((x) => <li key={x} className="rounded-[14px] bg-raised px-3.5 py-2 font-mono text-[12.5px] text-ink">{x}</li>)}</ul>}
          {a.o.warning && <p role="alert" className="flex items-start gap-2 rounded-[14px] bg-warn/10 px-3.5 py-2.5 text-[13px] text-ink-2"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />{a.o.warning}</p>}
          <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={() => finish(false)}>{a.o.cancel ?? 'Cancel'}</Button><Button variant={a.o.danger ? 'danger' : 'primary'} onClick={() => finish(true)}>{a.o.confirm}</Button></div>
        </div>
      )}
    </Dialog>
  );
}

// --- status marks: one look for "connected", "needs a look", "broken", "working" and "not yet" --------------------------
// <StatusMark state="ok" /> replaces the plain green tick circles. A soft gradient ring (lime → green when it's fine,
// amber when it needs a look, red when it's broken or expired, blue while it works, grey for not yet) around a crisp
// glyph that draws itself once when it appears. Live and working ones breathe a soft glow; nothing else moves. When the
// state changes, the old glyph shrinks away as the new one draws in and the ring's colours slide across (check → !).
// solid: a filled gradient disc, for the big "it worked" moments. Reduced motion: drawn at once, and still. The look
// is .smark in styles.css; readers hear the label ("Connected" by default for ok).
export type MarkState = 'ok' | 'live' | 'work' | 'warn' | 'bad' | 'off';
const MARK_WORD: Record<MarkState, string> = { ok: 'Connected', live: 'Live', work: 'Working on it', warn: 'Needs a look', bad: 'Broken', off: 'Not yet' };
const GLYPH = {
  check: 'M7.3 12.5l3.15 3.1 6.25-6.75',
  bang: 'M12 7.3v5.6M12 16.55v.05',
  cross: 'M8.7 8.7l6.6 6.6M15.3 8.7l-6.6 6.6',
  dot: 'M12 12v.05',
} as const;
const GLYPH_OF: Record<MarkState, keyof typeof GLYPH> = { ok: 'check', live: 'check', work: 'dot', warn: 'bang', bad: 'cross', off: 'dot' };
export function StatusMark({ state = 'ok', size = 20, label, solid, className }: { state?: MarkState; size?: number; label?: string; solid?: boolean; className?: string }) {
  const id = `sm${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const g = GLYPH_OF[state];
  // the glyph it showed before, for a moment, so a change morphs instead of jumping
  const [cur, setCur] = useState(g);
  const [prev, setPrev] = useState<keyof typeof GLYPH | null>(null);
  if (cur !== g) { setPrev(cur); setCur(g); }
  useEffect(() => { if (!prev) return; const t = setTimeout(() => setPrev(null), 320); return () => clearTimeout(t); }, [prev]);
  const word = label ?? MARK_WORD[state];
  return (
    <span role="img" aria-label={word} title={word} className={cx('smark', `smark-${state}`, solid && 'smark-solid', className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
        <defs><linearGradient id={id} x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" className="smark-s1" /><stop offset="1" className="smark-s2" /></linearGradient></defs>
        <circle className="smark-fill" cx="12" cy="12" r={solid ? 11.5 : 10.2} style={solid ? { fill: `url(#${id})` } : undefined} />
        {!solid && <circle className="smark-ring" cx="12" cy="12" r="10.2" pathLength={1} stroke={`url(#${id})`} />}
        {prev && <path key={`was-${prev}`} className="smark-glyph smark-out" d={GLYPH[prev]} pathLength={1} />}
        <path key={g} className="smark-glyph" d={GLYPH[g]} pathLength={1} />
      </svg>
    </span>
  );
}

// --- 3D illustrations (web/public/illustrations): soft clay icons for empty states, one per state, never in busy lists.
// Width and height come from each file so nothing shifts while it loads; decorative (alt="") unless told otherwise.
// It floats gently while it or its card (.illo-host) is hovered; reduced motion keeps it still.
const ILLO = {
  'add-server': [300, 243], apps: [300, 284], backup: [360, 276], chat: [280, 234], cleanup: [244, 300], clear: [237, 280],
  clients: [300, 267], connections: [300, 298], costs: [300, 292], deploy: [292, 360], domain: [360, 281], gift: [274, 300],
  map: [300, 270], offline: [270, 280], projects: [300, 266], routines: [287, 300], servers: [345, 360],
} as const;
export type IllustrationName = keyof typeof ILLO;
export function Illustration({ name, size = 96, className, alt = '' }: { name: IllustrationName; size?: number; className?: string; alt?: string }) {
  const [w, h] = ILLO[name];
  const k = size / Math.max(w, h);
  return (
    <img src={`/illustrations/${name}.webp`} alt={alt} width={Math.round(w * k)} height={Math.round(h * k)} loading="lazy" decoding="async" draggable={false}
      className={cx('illo shrink-0 select-none drop-shadow-[0_12px_16px_rgb(40_30_90/0.16)]', className)} />
  );
}

// --- "Show details": the whole text behind a short error (a build log), in a centred pop-up -------------------------
// A toast's body and a chat line say one plain sentence; the full text opens here: dark, monospaced, scrolling, with
// Copy. The server already took secrets out; secret addresses (credential://…) are masked here too.
let details: { title: string; text: string } | null = null;
const detailSubs = new Set<() => void>();
export function showDetails(title: string, text: string) { details = { title, text: rawWords(text) }; detailSubs.forEach((f) => f()); }
function DetailsHost() {
  const d = useSyncExternalStore((cb) => { detailSubs.add(cb); return () => detailSubs.delete(cb); }, () => details);
  const last = useRef(d);
  if (d) last.current = d;
  const shown = d ?? last.current;
  const close = () => { details = null; detailSubs.forEach((f) => f()); };
  return (
    <Modal open={!!d} onClose={close} title={shown?.title ?? 'Details'} size="lg">
      <p className="mb-3 text-[13px] text-muted">The full message, as Unit7 got it. Secrets are taken out.</p>
      <pre tabIndex={0} aria-label="Full message" className="max-h-[min(55dvh,480px)] overflow-auto whitespace-pre-wrap break-words rounded-[16px] bg-[#0d0f14] p-4 font-mono text-[12px] leading-relaxed text-[#d7dbe4] ring-1 ring-white/10 focus-visible:outline-lime">{shown?.text}</pre>
      <div className="mt-4 flex justify-end gap-2">
        <CopyText text={shown?.text ?? ''} />
        <Button variant="dark" onClick={close}>Close</Button>
      </div>
    </Modal>
  );
}
function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <Button variant="secondary" icon={done ? <Check size={14} className="text-ok" /> : <Copy size={14} />} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }); }}>{done ? 'Copied' : 'Copy'}</Button>;
}

// A failed step or a bad status line in the chat: its one plain sentence, and "Show details" for the rest (never a raw
// log inline). detail: a log the result carried separately (logTail).
export function ErrorLine({ text, detail, title = 'What happened', className }: { text: string; detail?: string; title?: string; className?: string }) {
  const p = plainError(text);
  const more = detail ? `${text}\n\n${detail}` : p.more;
  return (
    <p className={cx('break-words text-[12.5px] text-bad', className)}>
      {p.line}
      {more && <>{' '}<button type="button" onClick={() => showDetails(title, more)} className="whitespace-nowrap rounded font-medium text-ink-2 underline decoration-line-strong underline-offset-2 transition hover:text-ink hover:decoration-current">Show details</button></>}
    </p>
  );
}
