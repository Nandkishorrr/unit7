// The map as one calm canvas that fills the screen: drag to move it, scroll or pinch to zoom, +/− and Fit. Domains on
// the left in a frame per DNS host, apps in a frame per server or account (a band per project), their data on the
// right. Hover anything to light its whole path; click it for its pop-up. A big estate starts as bubbles with counts:
// click one (or zoom into it) to open it, zoom far out to fold everything back. Unused subdomains wait in one cluster
// per domain; hover it and they fan out, ready to drag onto an app.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, ChevronDown, ChevronUp, Map as MapGlyph, Maximize, Minus, Plus, Sparkles, X } from 'lucide-react';
import { HoverCard, cx, timeAgo } from '../../ui';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { ownerLogo, size as bytes } from '../servers/shape';
import { ENGINE_COLOR, abandoned, engineOf, issueLabel, liveOf, logoOf, pointable, targetsOf, type Asset } from './data';
import { AX, DX, layoutMap, type Box, type FrameKind, type MFrame, type MapLayout, type MNode } from './layout';
import { camAt, camDrag, inside, miniFit, viewRect } from './minimap';
import { plural, short, useMap } from './parts';
import { ReadinessRing } from '../care';
import { useReadinessOf } from '../care/data';
import { openDomainLaunch } from '../flow/DomainLaunch';
import { MapFan } from '../fleet/MapFan';

const MIN = 0.2, MAX = 2.2;
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const INSET = { top: 84, side: 36, bottom: 64 }; // room for the floating bars (top: measured from the toolbar)
const topInset = (vp: HTMLElement | null) => { const bar = vp?.parentElement?.querySelector<HTMLElement>('[data-toolbar]'); return bar ? bar.offsetTop + bar.offsetHeight + 14 : INSET.top; };

// --- the camera: one transform on the world, painted straight to the DOM (no re-render while you drag) ---------------
interface Cam { x: number; y: number; k: number }
function useCamera() {
  const vp = useRef<HTMLDivElement>(null), world = useRef<HTMLDivElement>(null);
  const cam = useRef<Cam>({ x: 0, y: 0, k: 1 });
  const subs = useRef(new Set<() => void>());
  const raf = useRef(0);
  const paint = useCallback(() => {
    const { x, y, k } = cam.current;
    if (world.current) world.current.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`;
    if (vp.current) { vp.current.style.backgroundPosition = `${x}px ${y}px`; vp.current.style.backgroundSize = `${26 * k}px ${26 * k}px`; }
    subs.current.forEach((f) => f());
  }, []);
  const to = useCallback((next: Cam, ms = 0) => {
    cancelAnimationFrame(raf.current);
    if (!ms || reduced()) { cam.current = next; paint(); return; }
    const from = { ...cam.current }, t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms), e = 1 - (1 - p) ** 3;
      cam.current = { x: from.x + (next.x - from.x) * e, y: from.y + (next.y - from.y) * e, k: from.k + (next.k - from.k) * e };
      paint();
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, [paint]);
  return useMemo(() => {
    const size = () => ({ w: vp.current?.clientWidth ?? 1, h: vp.current?.clientHeight ?? 1 });
    return {
      vp, world, cam, to, size,
      zoomAt(px: number, py: number, f: number, ms = 0) {
        const c = cam.current, k = clamp(c.k * f, MIN, MAX);
        to({ k, x: px - (px - c.x) * (k / c.k), y: py - (py - c.y) * (k / c.k) }, ms);
      },
      pan(dx: number, dy: number, ms = 0) { const c = cam.current; to({ ...c, x: c.x + dx, y: c.y + dy }, ms); },
      fit(b: Box, ms = 0, maxK = 1) {
        const { w, h } = size(), top = topInset(vp.current);
        const k = clamp(Math.min((w - INSET.side * 2) / b.w, (h - top - INSET.bottom) / b.h), MIN, maxK);
        // a phone: never so small it can't be read; start at the top left (domains first) and let a finger pan
        if (w < 640 && k < 0.6) { to({ k: 0.6, x: 16 - b.x * 0.6, y: top - b.y * 0.6 }, ms); return; }
        to({ k, x: (w - b.w * k) / 2 - b.x * k, y: top + Math.max(0, (h - top - INSET.bottom - b.h * k) / 2) - b.y * k }, ms);
      },
      // a box in the middle of the screen (its top in view when it's taller than the screen)
      show(b: Box, k: number, ms = 450) {
        const { w, h } = size(), t = topInset(vp.current);
        const top = b.h * k > h - t - INSET.bottom ? t + 8 - b.y * k : (h + t - INSET.bottom) / 2 - (b.y + b.h / 2) * k;
        to({ k, x: w / 2 - (b.x + b.w / 2) * k, y: top }, ms);
      },
      subscribe: (f: () => void) => { subs.current.add(f); return () => { subs.current.delete(f); }; },
      zoom: () => Math.round(cam.current.k * 100),
    };
  }, [to]);
}
type Camera = ReturnType<typeof useCamera>;

export interface CanvasHandle { fly: (assetId: string) => void; fit: () => void }

export const Canvas = forwardRef<CanvasHandle, { show: Set<string>; intro?: boolean }>(function Canvas({ show, intro: first = true }, ref) {
  const ctx = useMap();
  const { v, service, connect, human } = ctx;
  const camera = useCamera();
  const [over, setOver] = useState<Map<string, boolean>>(() => new Map());
  // a big estate opens as bubbles (a frame of one thing is just that thing); a small one shows everything
  const big = useMemo(() => {
    const things = v.assets.filter((a) => show.has(a.id) && (a.kind === 'app' || a.kind === 'service' || a.kind === 'database')).length;
    return things > 24 || v.groups.filter((g) => [g.asset, ...g.subs].some((d) => d && show.has(d.id))).length > 16;
  }, [v, show]);
  const isOpen = useCallback((id: string, kind: FrameKind, n: number) => over.get(id) ?? (kind === 'band' || !big || n <= 1), [over, big]);
  const L = useMemo(() => layoutMap({ v, show, open: isOpen, title: providerName, owner: ownerLogo, product: ctx.product, projectOf: (a) => { const s = service(a); return s ? { id: s.projectId, name: s.project } : undefined; } }), [v, show, isOpen, service, ctx.product]);
  const Lref = useRef(L);
  Lref.current = L;
  const bounds = useMemo<Box>(() => ({ x: -24, y: -48, w: L.w + 48, h: L.h + 72 }), [L]);

  // --- the path under the pointer (or the thing search found), everything else dims ---------------------------------
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const adj = useMemo(() => {
    const down = new Map<string, string[]>(), up = new Map<string, string[]>();
    for (const [a, b] of L.links) { down.set(a, [...(down.get(a) ?? []), b]); up.set(b, [...(up.get(b) ?? []), a]); }
    return { down, up };
  }, [L]);
  const dragging = useRef(false);
  const lit = useMemo(() => {
    const at = hover ?? focus;
    if (!at || dragging.current) return null; // while a subdomain is dragged, every app stays bright
    const set = new Set([at]);
    if (at.startsWith('unused:')) return null; // its fan is the focus, and every app stays bright to drop one on
    for (const m of [adj.down, adj.up]) { const q = [at]; while (q.length) for (const n of m.get(q.shift()!) ?? []) if (!set.has(n)) { set.add(n); q.push(n); } }
    return set;
  }, [hover, focus, adj]);

  // --- opening and folding frames, then settling the camera on what changed -------------------------------------------
  const pending = useRef<{ frame?: string; node?: string; all?: boolean } | null>(null);
  const setFrame = useCallback((id: string, on: boolean, then?: typeof pending.current) => { pending.current = then ?? null; touched.current = true; setOver((o) => new Map(o).set(id, on)); }, []);
  const fitted = useRef(false), touched = useRef(false);
  useLayoutEffect(() => {
    if (!fitted.current && L.nodes.length + L.frames.length) { camera.fit(bounds); fitted.current = true; return; }
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    if (p.all) { camera.fit(bounds, 480); return; }
    if (p.node) {
      if (L.rep(p.node) !== p.node) { const chain = L.within.get(p.node) ?? []; pending.current = p; setOver((o) => { const n = new Map(o); for (const f of chain) n.set(f, true); return n; }); return; }
      const b = L.box.get(p.node);
      if (b) camera.show(b, Math.max(0.9, Math.min(1.15, camera.cam.current.k)));
      return;
    }
    const f = p.frame && L.frames.find((x) => x.id === p.frame);
    if (f) camera.show(f, clamp(Math.min((camera.size().w - 80) / f.w, (camera.size().h - topInset(camera.vp.current) - INSET.bottom) / f.h), 0.85, 1));
  }, [L, bounds, camera]);
  // the screen changed size: fit again, unless you've moved the map yourself
  useEffect(() => {
    const el = camera.vp.current!;
    const ro = new ResizeObserver(() => { if (!touched.current && fitted.current) camera.fit(boundsRef.current); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [camera]);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  useImperativeHandle(ref, () => ({
    fly(assetId: string) {
      const node = Lref.current.nodeOf.get(assetId) ?? assetId;
      touched.current = true;
      setFocus(node);
      const cur = Lref.current;
      if (cur.rep(node) !== node) { pending.current = { node }; setOver((o) => { const n = new Map(o); for (const f of cur.within.get(node) ?? []) n.set(f, true); return n; }); return; }
      const b = cur.box.get(node);
      if (b) camera.show(b, Math.max(0.9, Math.min(1.15, camera.cam.current.k)));
    },
    fit() { touched.current = false; camera.fit(boundsRef.current, 420); },
  }), [camera]);

  // --- semantic zoom: zoom into a bubble and it opens; zoom far out and everything folds back into bubbles ------------
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const afterZoom = useCallback((px: number, py: number, dir: number) => {
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      const { x, y, k } = camera.cam.current;
      const cur = Lref.current;
      if (dir > 0 && k >= 1.3) {
        const wx = (px - x) / k, wy = (py - y) / k;
        const f = cur.frames.find((b) => !b.open && wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h);
        if (f) setFrame(f.id, true, { frame: f.id });
      }
      if (dir < 0 && k <= 0.38 && big) {
        const shut = cur.frames.filter((f) => f.open && f.kind !== 'band' && f.members.length > 3);
        if (shut.length) { pending.current = { all: true }; setOver((o) => { const n = new Map(o); for (const f of shut) n.set(f.id, false); return n; }); }
      }
    }, 200);
  }, [camera, big, setFrame]);

  // --- pan (drag), pinch, wheel, keys ----------------------------------------------------------------------------------
  const moved = useRef(false);
  useEffect(() => {
    const el = camera.vp.current!;
    const pts = new Map<number, { x: number; y: number }>();
    let start: { x: number; y: number; id: number } | null = null, pinch = 0;
    const local = (e: { clientX: number; clientY: number }) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const down = (e: PointerEvent) => {
      if ((e.pointerType === 'mouse' && e.button !== 0) || (e.target as Element).closest('[data-drag],[data-bar]')) return;
      pts.set(e.pointerId, local(e));
      if (pts.size === 1) { start = { ...local(e), id: e.pointerId }; moved.current = false; }
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y); try { el.setPointerCapture(e.pointerId); } catch { /* gone */ } }
    };
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e), last = pts.get(e.pointerId)!;
      pts.set(e.pointerId, p);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (pinch) { camera.zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, d / pinch); afterZoom((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, d - pinch); }
        pinch = d; moved.current = true; touched.current = true;
        return;
      }
      if (start && !moved.current && Math.hypot(p.x - start.x, p.y - start.y) > 4) {
        moved.current = true; touched.current = true;
        try { el.setPointerCapture(e.pointerId); } catch { /* gone */ }
        el.dataset.panning = '';
      }
      if (moved.current) camera.pan(p.x - last.x, p.y - last.y);
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = 0;
      if (!pts.size) { start = null; delete el.dataset.panning; }
    };
    // a drag that moved the map isn't a click on whatever it ended over
    const click = (e: MouseEvent) => { if (moved.current) { e.stopPropagation(); e.preventDefault(); moved.current = false; } };
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest('[data-bar]')) return;
      e.preventDefault();
      touched.current = true;
      el.dispatchEvent(new Event('scroll')); // an open hover card closes, instead of floating where its node used to be
      const p = local(e);
      if (e.ctrlKey) { const f = Math.exp(-e.deltaY * 0.012); camera.zoomAt(p.x, p.y, f); afterZoom(p.x, p.y, f - 1); return; } // a trackpad pinch
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { camera.pan(-(e.deltaX || e.deltaY), e.shiftKey ? 0 : -e.deltaY); return; }
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.06 : 0.0022));
      camera.zoomAt(p.x, p.y, f); afterZoom(p.x, p.y, f - 1);
    };
    // focusing something off screen scrolls even a clipped box: the camera moves instead (onFocusIn), so undo the scroll
    const noScroll = () => { if (el.scrollTop || el.scrollLeft) { el.scrollTop = 0; el.scrollLeft = 0; } };
    el.addEventListener('scroll', noScroll);
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('click', click, true); el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      el.removeEventListener('click', click, true); el.removeEventListener('wheel', wheel); el.removeEventListener('scroll', noScroll);
    };
  }, [camera, afterZoom]);

  const zoomBy = useCallback((f: number) => { const { w, h } = camera.size(); touched.current = true; camera.zoomAt(w / 2, h / 2, f, 220); afterZoom(w / 2, h / 2, f - 1); }, [camera, afterZoom]);
  const fitAll = useCallback(() => { touched.current = false; camera.fit(boundsRef.current, 420); }, [camera]);
  // keys work anywhere on the page (not while typing, or with a pop-up open): arrows pan, +/− zoom, 0 fits
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as Element;
    if (e.metaKey || e.ctrlKey || e.altKey || t.closest?.('input, textarea, select, [contenteditable=true], [role=menu], dialog[open]') || document.querySelector('dialog[open]')) return;
    const step = 90;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => camera.pan(step, 0, 160), ArrowRight: () => camera.pan(-step, 0, 160), ArrowUp: () => camera.pan(0, step, 160), ArrowDown: () => camera.pan(0, -step, 160),
      '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(0.8), _: () => zoomBy(0.8), '0': fitAll,
      Escape: () => { setFocus(null); setFan(null); },
    };
    const k = keys[e.key];
    if (!k) return;
    e.preventDefault(); touched.current = true; k();
  };
  useEffect(() => { const f = (e: KeyboardEvent) => keyRef.current(e); addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, []);
  // Tab onto something off screen: bring it into view
  const onFocusIn = (e: React.FocusEvent) => {
    const id = (e.target as Element).closest<HTMLElement>('[data-node]')?.dataset.node;
    const b = id && Lref.current.box.get(id);
    if (!b) return;
    const { x, y, k } = camera.cam.current, { w, h } = camera.size();
    const sx = b.x * k + x, sy = b.y * k + y;
    if (sx < 0 || sy < INSET.top - 20 || sx + b.w * k > w || sy + b.h * k > h - 20) camera.show(b, Math.max(k, 0.8), 260);
  };

  // --- unused subdomains: the fan, and dragging one onto an app ---------------------------------------------------------
  const [fan, setFan] = useState<string | null>(null);
  const fanTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fanTo = (id: string | null, ms: number) => { clearTimeout(fanTimer.current); fanTimer.current = setTimeout(() => setFan(id), ms); };
  const [drag, setDrag] = useState<{ d: Asset; root: string; x: number; y: number; over?: string } | null>(null);
  const startDrag = (d: Asset, root: string) => (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY;
    let going = false;
    const move = (ev: PointerEvent) => {
      if (!going && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      if (!going) { dragging.current = true; setHover(null); }
      going = true;
      const at = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-drop]')?.dataset.drop;
      setDrag({ d, root, x: ev.clientX, y: ev.clientY, over: at });
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (!going) return; // a plain click: the chip's own onClick picks an app
      dragging.current = false;
      const at = ev.type === 'pointerup' ? document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-drop]')?.dataset.drop : undefined;
      setDrag(null);
      suppress.current = true; setTimeout(() => (suppress.current = false), 50);
      if (at) connect({ root, subs: [d], app: at });
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  };
  const suppress = useRef(false);

  // the minimap: shown unless folded away (remembered on this browser)
  const [mini, setMiniState] = useState(() => { try { return localStorage.getItem('unit7.map.minimap') !== 'off'; } catch { return true; } });
  const setMini = (on: boolean) => { setMiniState(on); try { localStorage.setItem('unit7.map.minimap', on ? 'on' : 'off'); } catch { /* not remembered */ } };

  // the first time it draws: lines draw in and the nodes rise, a column at a time; after that, things just move
  const [intro, setIntro] = useState(first);
  useEffect(() => { const t = setTimeout(() => setIntro(false), 1600); return () => clearTimeout(t); }, []);
  const version = useRef(0);
  const shown = useMemo(() => { version.current++; return L; }, [L]);

  const items = useMemo(() => [
    ...shown.frames.map((f) => ({ col: f.kind === 'dns' ? 0 : f.x >= DX - 30 ? 2 : 1, y: f.y, f })),
    ...shown.nodes.filter((n) => n.kind !== 'server').map((n) => ({ col: n.col, y: n.y, n })),
  ].sort((a, b) => a.col - b.col || a.y - b.y || ('f' in a ? -1 : 1)), [shown]);

  const dim = (id: string) => !!lit && !lit.has(id);
  const enter = (id: string) => () => setHover(id);
  const leave = () => setHover(null);

  return (
    <div ref={camera.vp} tabIndex={0} role="application" aria-label="The map. Drag to move, scroll to zoom, arrow keys to move, plus and minus to zoom, 0 to fit."
      onFocus={onFocusIn} onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as Element).hasAttribute('data-world')) { setFocus(null); } }}
      className="map-vp group/vp absolute inset-0 cursor-grab touch-none select-none overflow-hidden outline-none data-[panning]:cursor-grabbing focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue/40"
      style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, var(--line-strong) 1px, transparent 0)' }}>
      <style>{`@keyframes map-draw{from{stroke-dashoffset:1}}@keyframes map-in{from{opacity:0;transform:translateY(10px)}}@keyframes map-fan{from{opacity:0;transform:translate(-64px,var(--dy)) scale(.6)}}@keyframes map-ping{from{opacity:.9;transform:scale(.97)}to{opacity:0;transform:scale(1.12)}}
        .map-move{transition:left .45s var(--ease-out-soft),top .45s var(--ease-out-soft),width .45s var(--ease-out-soft),height .45s var(--ease-out-soft),opacity .2s}`}</style>
      <div ref={camera.world} data-world="" className="absolute left-0 top-0 origin-top-left will-change-transform">
        {/* the three columns, named once */}
        {([['Domains', 12], ['Apps', AX], ['Data', DX]] as const).map(([t, x], i) => (
          <p key={t} className="absolute top-[-42px] flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint" style={{ left: x, animation: intro ? `map-in .5s var(--ease-out-soft) ${i * 140}ms both` : undefined }}>
            {t}
            {t === 'Domains' && human && <button type="button" onClick={() => openDomainLaunch()} title="Get a domain, or connect one you have"
              className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full border border-line-strong bg-surface px-2 text-[11px] font-medium normal-case tracking-normal text-ink-2 shadow-soft transition hover:border-blue/50 hover:text-ink"><Plus size={11} />Add a domain</button>}
          </p>
        ))}
        <svg key={version.current} aria-hidden className="pointer-events-none absolute left-0 top-0 z-[1] overflow-visible" width={Math.max(1, shown.w)} height={Math.max(1, shown.h)}
          style={{ animation: intro ? undefined : 'fade .3s ease-out' }}>
          {shown.edges.map((e, i) => {
            const on = !lit || (lit.has(e.from) && lit.has(e.to));
            const bad = e.status === 'misconfigured', faint = e.status === 'unknown';
            const color = bad ? 'var(--bad)' : faint ? 'var(--faint)' : lit && on ? 'var(--blue)' : 'color-mix(in srgb, var(--blue) 40%, var(--line-strong))';
            const w = (lit && on ? 2.2 : 1.5) + Math.min(2.5, Math.log2(e.n) * 0.9);
            const delay = 380 + Math.min(i * 12, 500);
            return (
              <g key={e.id} style={{ opacity: !lit ? 0.95 : on ? 1 : 0.08, transition: 'opacity .2s' }}>
                <path d={e.d} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round"
                  {...(!bad && !faint ? { pathLength: 1, strokeDasharray: intro ? '1 1' : undefined, style: intro ? { animation: `map-draw .9s var(--ease-out-soft) ${delay}ms both` } : undefined }
                    : { strokeDasharray: bad ? '6 5' : '2 5', style: intro ? { animation: `fade .5s ease-out ${delay}ms both` } : undefined })} />
                <circle cx={e.end[0]} cy={e.end[1]} r={3.2} fill={color} style={intro ? { animation: `fade .3s ease-out ${delay + 500}ms both` } : undefined} />
              </g>
            );
          })}
        </svg>
        <MapFan L={shown} intro={intro} />
        {items.map((it, i) => ('f' in it ? (
          <FrameView key={it.f.id} f={it.f} intro={intro} delay={it.col * 140} dim={dim(it.f.id) && !it.f.open}
            onEnter={enter(it.f.id)} onLeave={leave} onToggle={(on) => setFrame(it.f.id, on, on ? { frame: it.f.id } : undefined)} />
        ) : (
          <div key={it.n.id} data-node={it.n.id} onPointerEnter={enter(it.n.id)} onPointerLeave={leave}
            className={cx('map-move absolute', it.n.kind === 'cluster' ? (fan === it.n.id ? 'z-30' : 'z-[3]') : 'z-[2]', dim(it.n.id) && fan !== it.n.id && 'opacity-25')}
            style={{ left: it.n.x, top: it.n.y, width: it.n.w, height: it.n.h }}>
            {focus === it.n.id && <><span aria-hidden className={cx('pointer-events-none absolute -inset-1.5 ring-2 ring-blue/50', it.n.kind === 'domain' || it.n.kind === 'cluster' ? 'rounded-full' : it.n.kind === 'db' ? 'rounded-[26px]' : 'rounded-[18px]')} />
              <span aria-hidden className={cx('pointer-events-none absolute -inset-1.5 ring-4 ring-blue/40', it.n.kind === 'domain' || it.n.kind === 'cluster' ? 'rounded-full' : 'rounded-[18px]')} style={{ animation: 'map-ping 1.4s ease-out 3' }} /></>}
            <Enter intro={intro} delay={it.n.col * 140 + Math.min(i, 14) * 18}>
              {it.n.kind === 'domain' ? <DomainPill n={it.n} onArrow={(t) => { const c = Lref.current, b = c.box.get(c.rep(c.nodeOf.get(t) ?? t)); touched.current = true; setFocus(it.n.id); if (b) camera.show(b, Math.max(0.9, camera.cam.current.k)); }} />
                : it.n.kind === 'cluster' ? <Cluster n={it.n} open={fan === it.n.id} human={human} onOpen={(on, ms) => fanTo(on ? it.n.id : null, ms)} startDrag={startDrag} suppress={suppress} />
                  : it.n.kind === 'app' ? <AppNode a={it.n.asset!} drop={!!drag && pointable(it.n.asset!)} over={drag?.over === it.n.asset!.id} faded={!!drag && !pointable(it.n.asset!)} />
                    : <DbNode a={it.n.asset!} />}
            </Enter>
          </div>
        )))}
      </div>

      {drag && (
        <div className="pointer-events-none fixed z-[60] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink px-3.5 py-2 text-[13px] font-medium text-bg shadow-float" style={{ left: drag.x, top: drag.y }}>
          {drag.d.name}{drag.over ? <span className="text-lime"> → {ctx.label(v.byId.get(drag.over)!)}</span> : <span className="opacity-60"> · drop on an app</span>}
        </div>
      )}

      {/* bottom left, clear of Warden in the corner: the minimap, zoom, fit, and what the lines mean */}
      {mini && <Minimap L={shown} bounds={bounds} camera={camera} onMove={() => (touched.current = true)} />}
      <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex items-center gap-4">
        <div data-bar="" className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-line bg-surface/90 p-1 shadow-soft backdrop-blur">
          <RoundBtn label="Zoom out (−)" onClick={() => zoomBy(0.8)}><Minus size={16} /></RoundBtn>
          <ZoomLabel camera={camera} />
          <RoundBtn label="Zoom in (+)" onClick={() => zoomBy(1.25)}><Plus size={16} /></RoundBtn>
          <span className="mx-0.5 h-5 w-px bg-line" />
          <RoundBtn label="Fit to screen (0)" onClick={fitAll}><Maximize size={15} /></RoundBtn>
          <span className="hidden md:contents">
            <button type="button" aria-pressed={mini} aria-label={mini ? 'Hide the mini map' : 'Show the mini map'} title={mini ? 'Hide the mini map' : 'Show the mini map'} onClick={() => setMini(!mini)}
              className={cx('grid size-9 place-items-center rounded-full transition', mini ? 'bg-raised text-ink' : 'text-ink-2 hover:bg-raised hover:text-ink')}><MapGlyph size={15} /></button>
          </span>
        </div>
        <p className="hidden h-9 items-center gap-4 rounded-full bg-surface/80 px-3.5 text-[11.5px] text-muted backdrop-blur lg:flex">
          <span className="inline-flex items-center gap-1.5"><svg width="20" height="6" aria-hidden><path d="M1 3h18" stroke="color-mix(in srgb, var(--blue) 40%, var(--line-strong))" strokeWidth="2" strokeLinecap="round" /></svg>Works</span>
          <span className="inline-flex items-center gap-1.5"><svg width="20" height="6" aria-hidden><path d="M1 3h18" stroke="var(--bad)" strokeWidth="2" strokeDasharray="4 3" /></svg>Points elsewhere</span>
          <span>Drag to move · scroll to zoom · hover to follow a line</span>
        </p>
      </div>
    </div>
  );
});

// --- the minimap: the whole layout, small, with the screen as a rectangle. Click to go there, drag to move it. --------
// Cheap: plain rects from the layout already worked out, redrawn only when the layout changes; the rectangle follows
// the camera straight in the DOM. Not on phones (there the whole canvas is a finger away).
const MINI = { w: 196, h: 124 };
function Minimap({ L, bounds, camera, onMove }: { L: MapLayout; bounds: Box; camera: Camera; onMove: () => void }) {
  const { v } = useMap();
  const fit = miniFit(bounds, MINI);
  const rect = useRef<SVGRectElement>(null);
  const now = useRef({ bounds, s: fit.s });
  now.current = { bounds, s: fit.s };
  useEffect(() => {
    const paint = () => {
      const el = rect.current;
      if (!el) return;
      const r = viewRect(camera.cam.current, camera.size(), now.current.bounds, now.current.s);
      // kept inside the box, so a screen bigger than the map is just the whole box
      const x = clamp(r.x, 0, fit.w), y = clamp(r.y, 0, fit.h);
      el.setAttribute('x', String(x)); el.setAttribute('y', String(y));
      el.setAttribute('width', String(Math.max(4, clamp(r.x + r.w, 0, fit.w) - x))); el.setAttribute('height', String(Math.max(4, clamp(r.y + r.h, 0, fit.h) - y)));
    };
    paint();
    return camera.subscribe(paint);
  }, [camera, fit.w, fit.h, bounds]);
  const shapes = useMemo(() => {
    const at = (b: Box) => ({ x: (b.x - bounds.x) * fit.s, y: (b.y - bounds.y) * fit.s, width: Math.max(1.5, b.w * fit.s), height: Math.max(1.5, b.h * fit.s) });
    return (
      <>
        {L.frames.map((f) => <rect key={f.id} {...at(f)} rx={f.open ? 4 : 3} fill={f.open ? 'var(--raised)' : 'var(--line-strong)'} stroke={f.open ? 'var(--line-strong)' : f.attention ? '#f59e0b' : 'none'} strokeWidth={f.open ? 0.75 : 1} />)}
        {L.nodes.filter((n) => n.kind !== 'server').map((n) => (
          <rect key={n.id} {...at(n)} rx={n.kind === 'db' ? 4 : 2}
            fill={(n.asset && v.attention(n.asset)) || (n.group && v.groupAttention(n.group)) ? '#f59e0b' : n.col === 0 ? 'color-mix(in srgb, var(--blue) 55%, var(--surface))' : n.col === 2 ? 'color-mix(in srgb, var(--ok) 55%, var(--surface))' : 'var(--ink-2)'}
            opacity={n.col === 1 ? 0.45 : 0.85} />
        ))}
      </>
    );
  }, [L, bounds, fit.s, v]);
  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();
    const svg = e.currentTarget, box = svg.getBoundingClientRect();
    const p0 = { x: e.clientX - box.left, y: e.clientY - box.top };
    const vp = camera.size();
    // a press outside the rectangle brings the screen there first; from then on the rectangle follows the pointer
    let from = camera.cam.current;
    if (!inside(viewRect(from, vp, bounds, fit.s), p0.x, p0.y)) { from = camAt(p0.x, p0.y, from, vp, bounds, fit.s); camera.to(from, 220); }
    onMove();
    try { svg.setPointerCapture(e.pointerId); } catch { /* gone */ }
    const move = (ev: PointerEvent) => camera.to(camDrag(from, ev.clientX - box.left - p0.x, ev.clientY - box.top - p0.y, fit.s));
    const up = () => { svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up); };
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  };
  return (
    <div data-bar="" className="absolute bottom-[60px] left-3 z-20 hidden rounded-[16px] border border-line bg-surface/90 p-1.5 shadow-soft backdrop-blur md:block" style={{ animation: 'fade .3s ease-out' }}>
      <svg role="img" aria-label="Mini map of the whole canvas. Click or drag in it to move there." width={fit.w} height={fit.h} viewBox={`0 0 ${fit.w} ${fit.h}`} onPointerDown={down}
        className="block cursor-pointer touch-none overflow-hidden rounded-[10px]">
        {shapes}
        <rect ref={rect} rx={3} fill="color-mix(in srgb, var(--blue) 10%, transparent)" stroke="var(--blue)" strokeWidth={1.5} className="cursor-grab" />
      </svg>
    </div>
  );
}

function Enter({ intro, delay, children }: { intro: boolean; delay: number; children: ReactNode }) {
  // decided once, when it first appears: the first draw rises a column at a time, later arrivals just fade in
  const [first] = useState(intro);
  return <div className="h-full w-full" style={{ animation: first ? `map-in .5s var(--ease-out-soft) ${delay}ms backwards` : 'fade .3s ease-out' }}>{children}</div>;
}

function RoundBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className="grid size-9 place-items-center rounded-full text-ink-2 transition hover:bg-raised hover:text-ink">{children}</button>;
}
function ZoomLabel({ camera }: { camera: Camera }) {
  const z = useSyncExternalStore(camera.subscribe, camera.zoom);
  return <span aria-live="off" className="tabular w-9 text-center text-[11px] font-medium text-muted">{z}%</span>;
}

// --- frames: open (a soft panel with its name) or closed (a bubble with counts) --------------------------------------------
const countsWords = (f: MFrame) => [f.counts.projects > 1 && plural(f.counts.projects, 'project'), f.counts.domains && plural(f.counts.domains, 'domain'), f.counts.apps && plural(f.counts.apps, 'app'), f.counts.dbs && `${f.counts.dbs} db`].filter(Boolean).join(' · ');
function FrameView({ f, intro, delay, dim, onEnter, onLeave, onToggle }: { f: MFrame; intro: boolean; delay: number; dim: boolean; onEnter: () => void; onLeave: () => void; onToggle: (open: boolean) => void }) {
  const { v, open, label } = useMap();
  const logo = <BrandLogo id={f.logo === 'elsewhere' || f.logo === 'test' ? 'domain' : f.logo} size={f.kind === 'band' ? 14 : 17} />;
  const warn = f.attention > 0 && <span title={`${plural(f.attention, 'thing')} to look at`} className="size-2 shrink-0 rounded-full bg-[#f59e0b] ring-4 ring-[#f59e0b]/15" />;
  const style: CSSProperties = { left: f.x, top: f.y, width: f.w, height: f.h };
  if (!f.open) {
    const members = f.members.map((id) => v.byId.get(id) ?? v.groups.find((g) => `root:${g.root}` === id)?.subs[0]).filter((a): a is Asset => !!a);
    return (
      <div className={cx('map-move absolute z-[2]', dim && 'opacity-25')} style={style} data-node={f.id} onPointerEnter={onEnter} onPointerLeave={onLeave}>
        <Enter intro={intro} delay={delay}>
          <HoverCard content={<div className="w-[248px]"><p className="font-semibold">{f.title}{f.sub ? <span className="font-normal text-muted"> · {f.sub}</span> : null}</p>
            <ul className="mt-2 space-y-1">{members.slice(0, 6).map((a) => <li key={a.id} className="flex items-center gap-2 truncate text-[12.5px] text-ink-2"><BrandLogo id={a.kind === 'domain' ? a.dns ?? 'domain' : logoOf(a)} size={13} /><span className="truncate">{a.kind === 'domain' ? v.groupOf.get(a.id)?.root ?? a.name : label(a)}</span></li>)}</ul>
            {members.length > 6 && <p className="mt-1 text-[12px] text-muted">and {members.length - 6} more</p>}
            <p className="mt-2.5 text-[12px] text-muted">Click to open it</p></div>}>
            <button type="button" onClick={() => onToggle(true)} aria-expanded={false} aria-label={`${f.title}${f.sub ? `, ${f.sub}` : ''}: ${countsWords(f)}. Open`}
              className={cx('flex h-full w-full items-center gap-3 border bg-surface px-3.5 text-left shadow-soft transition hover:-translate-y-0.5 hover:border-ink/20 hover:shadow-lift',
                f.kind === 'band' ? 'rounded-[18px] border-dashed border-line-strong' : 'rounded-[24px] border-line')}>
              <span className={cx('grid shrink-0 place-items-center rounded-full bg-raised', f.kind === 'band' ? 'size-8' : 'size-10')}>{logo}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold tracking-[-0.01em]">{f.title}{f.sub && f.asset?.kind !== 'server' && <span className="font-normal text-muted"> · {f.sub}</span>}</span>
                <span className="block truncate text-[12px] text-muted">{countsWords(f)}</span>
              </span>
              {warn}
              <ChevronDown size={16} className="shrink-0 text-muted" />
            </button>
          </HoverCard>
        </Enter>
      </div>
    );
  }
  const server = f.kind === 'owner' && f.asset?.kind === 'server' ? f.asset : undefined;
  const head = f.kind === 'band' ? 'h-8 px-2.5 text-[12px]' : f.kind === 'dns' ? 'h-[42px] px-3 text-[13px]' : 'h-[50px] px-3 text-[13.5px]';
  const titleEl = (
    <span className="flex min-w-0 items-center gap-2">
      <span className={cx('grid shrink-0 place-items-center rounded-full bg-surface shadow-soft', f.kind === 'band' ? 'size-6' : 'size-8')}>{logo}</span>
      <span className="truncate font-semibold tracking-[-0.01em]">{f.title}</span>
      {f.sub && <span className="hidden truncate text-muted sm:inline">· {f.sub}</span>}
    </span>
  );
  return (
    <div className={cx('map-move absolute', f.kind === 'band' ? 'z-0 rounded-[18px] border border-dashed border-line-strong bg-surface/50' : 'z-0 rounded-[26px] border border-line bg-raised/55')} style={style}>
      <div className="h-full w-full" style={{ animation: intro ? `fade .5s ease-out ${delay}ms both` : undefined }}>
        <header className={cx('flex items-center gap-2', head)}>
          {server ? (
            <span data-node={server.id} onPointerEnter={onEnter} onPointerLeave={onLeave} className="min-w-0">
              <HoverCard content={<ServerHover a={server} f={f} />}>
                <button type="button" onClick={() => open(server.id)} className="flex min-w-0 items-center rounded-full pr-2 text-left hover:underline decoration-line-strong underline-offset-4">{titleEl}</button>
              </HoverCard>
            </span>
          ) : f.kind === 'band' && f.asset ? <button type="button" onClick={() => open(f.asset!.id)} className="min-w-0 text-left hover:underline decoration-line-strong underline-offset-4">{titleEl}</button> : titleEl}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {warn}
            {/* a narrow frame keeps its name readable; its counts are in the bubble and the hover card */}
            {(f.kind !== 'owner' || f.w >= 360) && <span className="hidden text-[11.5px] text-muted md:inline">{countsWords(f)}</span>}
            <button type="button" onClick={() => onToggle(false)} aria-expanded aria-label={`Fold ${f.title}`} title="Fold it into one bubble"
              className="grid size-7 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-ink"><ChevronUp size={15} /></button>
          </span>
        </header>
        {f.kind === 'owner' && !f.members.length && <p className="px-4 text-[12px] text-muted">Nothing found on it yet</p>}
      </div>
    </div>
  );
}

// --- nodes ---------------------------------------------------------------------------------------------------------------
const dotTone = { ok: 'bg-ok', warn: 'bg-[#f59e0b]', bad: 'bg-bad', idle: 'bg-transparent ring-1 ring-inset ring-line-strong' } as const;
function StatusDot({ tone, label }: { tone: keyof typeof dotTone; label: string }) {
  return <span role="img" aria-label={label} title={label} className={cx('size-2 shrink-0 rounded-full', dotTone[tone])} />;
}

function DomainPill({ n, onArrow }: { n: MNode; onArrow: (target: string) => void }) {
  const ctx = useMap();
  const { v, open } = ctx;
  const g = n.group!;
  const members = [g.asset, ...(n.linked ?? [])].filter((d): d is Asset => !!d);
  const reach = members.flatMap((d) => targetsOf(v, d));
  const issues = members.flatMap((d) => v.issuesOf(d.id));
  const bad = issues.some((i) => i.severity === 'critical') || reach.some((t) => t.edge.status === 'misconfigured');
  const tone = bad ? 'bad' : issues.length || members.some(v.attention) ? 'warn' : reach.length ? 'ok' : 'idle';
  const toneWord = { bad: 'Needs fixing', warn: 'Needs a look', ok: 'Works', idle: 'Not linked to anything here' }[tone];
  const first = reach.map((t) => ctx.v.byId.get(t.asset.id)).find(Boolean);
  const more = n.linked?.length ?? 0;
  const target = g.asset ?? members[0] ?? g.subs[0];
  return (
    <HoverCard content={<DomainHover n={n} />}>
      <button type="button" onClick={() => target && open(target.id)} aria-label={`${g.root}${more ? `, ${more} more` : ''}: ${toneWord}`}
        className="flex h-full w-full items-center gap-2 rounded-full border border-line bg-surface pl-1.5 pr-1.5 text-left shadow-soft transition hover:border-ink/20 hover:shadow-lift">
        <span className={cx('grid size-7 shrink-0 place-items-center rounded-full', g.dns ? 'bg-raised' : 'border border-dashed border-line-strong')}><BrandLogo id={g.dns ?? 'domain'} size={14} /></span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium tracking-[-0.01em]">{g.root}</span>
        {more > 0 && <span className="tabular shrink-0 rounded-full bg-raised px-1.5 py-0.5 text-[11px] font-medium text-muted">+{more}</span>}
        <StatusDot tone={tone} label={toneWord} />
        {first ? (
          <span role="button" tabIndex={-1} aria-hidden onClick={(e) => { e.stopPropagation(); onArrow(first.id); }} title={`Go to ${ctx.label(first)}`}
            className="grid size-7 shrink-0 place-items-center rounded-full text-muted transition hover:bg-blue-soft hover:text-blue-text"><ArrowRight size={14} /></span>
        ) : <span className="w-1" />}
      </button>
    </HoverCard>
  );
}

function DomainHover({ n }: { n: MNode }) {
  const { v, label, managed } = useMap();
  const g = n.group!;
  const rows = [...(g.asset ? [g.asset] : []), ...(n.linked ?? [])].map((d) => ({ d, t: targetsOf(v, d) }));
  const unused = g.subs.length - (n.linked?.length ?? 0);
  const issues = [g.asset, ...g.subs].flatMap((d) => (d ? v.issuesOf(d.id) : []));
  const tls = g.asset?.checks?.tls?.status ?? (managed.get(g.root)?.tls === 'active' ? 'ok' : undefined);
  return (
    <div className="w-[290px]">
      <p className="truncate text-[14px] font-semibold">{g.root}</p>
      <p className="mt-0.5 text-[12px] text-muted">{g.dns ? `DNS at ${providerName(g.dns)}` : 'DNS somewhere Unit7 can’t see'}{g.registrar && g.registrar !== g.dns ? ` · registered at ${providerName(g.registrar)}` : ''}{g.expires ? ` · until ${new Date(g.expires).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}` : ''}</p>
      <ul className="mt-2.5 space-y-1.5">
        {rows.slice(0, 7).map(({ d, t }) => (
          <li key={d.id} className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <span className="min-w-0 max-w-[45%] truncate font-medium">{d.id === g.asset?.id ? g.root : short(d, g.root)}</span>
            <ArrowRight size={12} className="shrink-0 text-faint" />
            {t.length ? <span className="flex min-w-0 items-center gap-1.5 truncate text-ink-2"><BrandLogo id={logoOf(t[0]!.asset)} size={12} /><span className="truncate">{label(t[0]!.asset)}</span>
              <StatusDot tone={t[0]!.edge.status === 'ok' ? 'ok' : t[0]!.edge.status === 'misconfigured' ? 'bad' : 'idle'} label={t[0]!.edge.status === 'ok' ? 'Works' : t[0]!.edge.status === 'misconfigured' ? 'Points elsewhere' : 'Not checked'} /></span>
              : <span className="text-faint">nothing here</span>}
          </li>
        ))}
      </ul>
      {rows.length > 7 && <p className="mt-1 text-[12px] text-muted">and {rows.length - 7} more</p>}
      {unused > 0 && <p className="mt-2 text-[12px] text-muted">{plural(unused, 'subdomain')} not used yet</p>}
      {(tls || issues.length > 0) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {tls && <span className={cx('rounded-full px-2 py-0.5 text-[11.5px] font-medium', tls === 'ok' ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn')}>{tls === 'ok' ? 'HTTPS on' : 'HTTPS needs a look'}</span>}
          {[...new Set(issues.map(issueLabel))].slice(0, 3).map((t) => <span key={t} className="rounded-full bg-warn/10 px-2 py-0.5 text-[11.5px] font-medium text-warn">{t}</span>)}
        </div>
      )}
      <p className="mt-2.5 text-[12px] text-muted">Click for details</p>
    </div>
  );
}

// "8 unused": hover and they fan out, each one ready to drag onto an app (or click to pick one)
function Cluster({ n, open, human, onOpen, startDrag, suppress }: { n: MNode; open: boolean; human: boolean; onOpen: (on: boolean, ms: number) => void; startDrag: (d: Asset, root: string) => (e: React.PointerEvent) => void; suppress: React.RefObject<boolean> }) {
  const { v, connect } = useMap();
  const g = n.group!, subs = n.unused ?? [];
  const risky = subs.filter((d) => abandoned(v, d) === 'takeover').length;
  const step = 32, H = subs.length * step + (human ? 44 : 0);
  // centred on the cluster, nudged up or down so the whole fan stays on screen
  const box = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const el = box.current, vp = el?.closest('.map-vp')?.getBoundingClientRect();
    if (!open || !el || !vp) { setShift(0); return; }
    const r = el.getBoundingClientRect(), k = r.height / n.h;
    const top = r.top + (n.h / 2 - H / 2) * k, bottom = top + H * k;
    const s = bottom > vp.bottom - 14 ? vp.bottom - 14 - bottom : 0;
    setShift((top + s < vp.top + 70 ? vp.top + 70 - top : s) / k);
  }, [open, H, n.h]);
  return (
    // a pointer opens it by hovering (or tapping), so a click never folds it back mid-reach; Enter and Space toggle it;
    // Escape, or Tab leaving the fan, folds it and puts focus back on the cluster
    <div ref={box} className="relative h-full w-full" onPointerEnter={() => onOpen(true, 140)} onPointerLeave={() => onOpen(false, 260)}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); onOpen(false, 0); btn.current?.focus(); } }}
      onBlur={(e) => { if (open && !e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget) onOpen(false, 0); }}>
      <button ref={btn} type="button" aria-expanded={open} aria-controls={`fan-${n.id}`} onClick={(e) => onOpen(e.detail === 0 ? !open : true, 0)} aria-label={`${subs.length} unused subdomains of ${g.root}${risky ? `, ${risky} can be taken over` : ''}`}
        className={cx('flex h-full w-full items-center gap-1.5 rounded-full border border-dashed px-2.5 text-[12px] font-medium transition',
          open ? 'border-blue/50 bg-blue-soft text-blue-text' : risky ? 'border-bad/40 bg-surface text-ink-2 hover:border-bad/60' : 'border-line-strong bg-surface text-ink-2 hover:border-ink/30')}>
        <span className="relative flex">{[0, 1, 2].slice(0, Math.min(3, subs.length)).map((i) => <span key={i} className="-ml-1 size-2.5 rounded-full border border-surface bg-line-strong first:ml-0" />)}</span>
        <span className="truncate">{subs.length} unused</span>
        {risky > 0 && <AlertTriangle size={12} className="shrink-0 text-bad" />}
        <Sparkles size={12} className={cx('ml-auto shrink-0 transition', open ? 'text-blue-text' : 'text-faint')} />
      </button>
      {open && (
        <div id={`fan-${n.id}`} className="absolute left-[calc(100%+10px)] w-[214px]" style={{ top: n.h / 2 - H / 2 + shift }}>
          {/* the invisible bridge keeps the fan open while the pointer crosses the gap */}
          <span aria-hidden className="absolute -left-3 top-0 h-full w-3" />
          <ul className="space-y-1">
            {subs.map((d, i) => {
              const risk = abandoned(v, d);
              const dy = H / 2 - i * step - 14 - shift; // from the cluster's middle
              return (
                <li key={d.id} className="flex items-center gap-1" style={{ '--dy': `${dy}px`, animation: `map-fan .34s var(--ease-out-soft) ${i * 24}ms both` } as CSSProperties}>
                  <button type="button" data-drag="" onPointerDown={human ? startDrag(d, g.root) : undefined} onClick={() => { if (!suppress.current && human) connect({ root: g.root, subs: [d] }); }}
                    title={human ? 'Drag onto an app, or click to pick one' : d.name}
                    className={cx('flex h-7 min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded-full border bg-surface pl-2.5 pr-2 text-left text-[12.5px] font-medium shadow-soft transition hover:border-blue/50 hover:shadow-lift active:cursor-grabbing',
                      risk === 'takeover' ? 'border-bad/40' : 'border-line')}>
                    {risk && <span className={cx('size-1.5 shrink-0 rounded-full', risk === 'takeover' ? 'bg-bad' : 'bg-[#f59e0b]')} />}
                    <span className="truncate">{short(d, g.root)}</span><span className="truncate font-normal text-faint">.{g.root}</span>
                  </button>
                  {human && risk && (
                    <button type="button" aria-label={`Remove ${d.name}`} title={risk === 'takeover' ? 'Points at something that’s gone: remove it' : 'Nothing answers here: remove it'} onClick={() => connect({ root: g.root, subs: [d], remove: true })}
                      className="grid size-7 shrink-0 place-items-center rounded-full border border-line bg-surface text-muted shadow-soft transition hover:border-bad/40 hover:text-bad"><X size={13} /></button>
                  )}
                </li>
              );
            })}
          </ul>
          {human && (
            <button type="button" onClick={() => connect({ root: g.root, subs, all: true })} style={{ animation: `map-fan .34s var(--ease-out-soft) ${subs.length * 24}ms both`, '--dy': '-20px' } as CSSProperties}
              className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-full bg-blue px-3 text-[12.5px] font-semibold text-white shadow-soft transition hover:brightness-110">
              <Sparkles size={13} />Connect all…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AppNode({ a, drop, over, faded }: { a: Asset; drop: boolean; over: boolean; faded: boolean }) {
  const { v, open, label } = useMap();
  const live = liveOf(a);
  const issues = v.issuesOf(a.id);
  const tone = issues.some((i) => i.severity === 'critical') || live?.tone === 'bad' ? 'bad' : issues.length || v.attention(a) || live?.tone === 'warn' ? 'warn' : live ? 'ok' : 'idle';
  const words = { bad: 'Down or broken', warn: 'Needs a look', ok: live?.text ?? 'Running', idle: 'No status yet' }[tone];
  return (
    <HoverCard content={<AppHover a={a} />}>
      <button type="button" data-drop={drop ? a.id : undefined} onClick={() => open(a.id)} aria-label={`${label(a)}: ${words}`}
        className={cx('flex h-full w-full items-center gap-2.5 rounded-[14px] border bg-surface pl-1.5 pr-3 text-left shadow-soft transition hover:border-ink/20 hover:shadow-lift',
          over ? 'border-blue ring-4 ring-blue-soft' : drop ? 'border-dashed border-blue/60' : 'border-line', faded && 'opacity-40')}>
        <span className="grid size-7 shrink-0 place-items-center rounded-[10px] bg-raised"><BrandLogo id={logoOf(a)} size={15} /></span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[-0.01em]">{label(a)}</span>
        <StatusDot tone={tone} label={words} />
      </button>
    </HoverCard>
  );
}

function AppHover({ a }: { a: Asset }) {
  const { v, label, service } = useMap();
  const live = liveOf(a);
  const doms = [...new Map([...v.inc(a.id, 'domain'), ...v.inc(a.id, 'dns')].map((e) => [e.source, v.byId.get(e.source)!])).values()].filter(Boolean);
  const used = [...new Map([...v.out(a.id, 'env'), ...v.out(a.id, 'uses')].map((e) => [e.target, v.byId.get(e.target)!])).values()].filter(Boolean);
  const data = used.filter((x) => x.kind === 'database'), talks = used.filter((x) => x.kind !== 'database');
  const dep = service(a)?.deploy;
  const ready = useReadinessOf(service(a)?.projectId ?? '');
  const host = a.platform && a.platform !== 'unit7' && a.platform !== 'vps' ? a.platform : a.provider;
  return (
    <div className="w-[270px] space-y-2.5">
      <div>
        <p className="truncate text-[14px] font-semibold">{label(a)}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted"><BrandLogo id={host === 'unit7' ? 'unit7' : logoOf(a)} size={12} />{a.owner ? `Run by ${providerName(a.owner)}` : host === 'unit7' ? 'On Unit7' : `On ${providerName(host)}`}{live ? ` · ${live.text}` : ''}</p>
      </div>
      <Facts rows={[
        ['Domains', doms.length ? doms.slice(0, 3).map((d) => d.name).join(', ') + (doms.length > 3 ? ` +${doms.length - 3}` : '') : 'None yet'],
        ['Data', data.length ? data.slice(0, 3).map(label).join(', ') + (data.length > 3 ? ` +${data.length - 3}` : '') : 'None it uses'],
        ['Talks to', talks.length ? talks.slice(0, 3).map(label).join(', ') + (talks.length > 3 ? ` +${talks.length - 3}` : '') : undefined],
        ['Last deploy', dep ? `${dep.at ? timeAgo(dep.at) : 'not yet'}${dep.status && dep.status !== 'live' ? ` · ${dep.status}` : ''}` : undefined],
        ['Errors', a.errors ? `${a.errors.hits} today` : undefined],
        ['Ready', ready?.total ? <span className="inline-flex items-center gap-1.5"><ReadinessRing done={ready.done} total={ready.total} size={14} label={false} />{ready.ready ? 'For real users' : `${ready.done} of ${ready.total} for real users`}</span> : undefined],
      ]} />
      <p className="text-[12px] text-muted">Click for details</p>
    </div>
  );
}

function Facts({ rows }: { rows: [string, ReactNode | undefined][] }) {
  return (
    <dl className="space-y-1">
      {rows.filter(([, x]) => x !== undefined && x !== '').map(([k, x]) => <div key={k} className="flex gap-3 text-[12.5px]"><dt className="w-[78px] shrink-0 text-muted">{k}</dt><dd className="min-w-0 flex-1 break-words text-ink-2">{x}</dd></div>)}
    </dl>
  );
}

// a database: a ring in its engine's colour around its logo; the ring fills with how much it stores (when known)
export function DbMark({ a, sizeOf }: { a: Asset; sizeOf: number | null }) {
  const { service } = useMap();
  const eng = engineOf(a, service(a)?.stack);
  const color = ENGINE_COLOR[eng] ?? 'var(--blue)';
  const r = 17, c = 2 * Math.PI * r;
  // ponytail: a log scale from 1 MB to 50 GB, not relative to the others; change it when sizes come from more scanners
  const frac = sizeOf ? clamp((Math.log10(sizeOf) - 6) / (Math.log10(50e9) - 6), 0.06, 1) : null;
  return (
    <span className="relative grid size-10 shrink-0 place-items-center">
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden className="absolute inset-0 -rotate-90">
        <circle cx="20" cy="20" r={r} fill={`color-mix(in srgb, ${color} 12%, transparent)`} stroke="var(--line-strong)" strokeWidth="3" strokeDasharray={frac === null ? '2 3' : undefined} />
        {frac !== null && <circle cx="20" cy="20" r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${frac * c} ${c}`} />}
      </svg>
      <BrandLogo id={eng} size={17} />
      {a.exposed && <span title="Open to the internet" className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-bad ring-2 ring-surface" />}
    </span>
  );
}
export const dbSize = (a: Asset) => a.size ?? a.backups?.size ?? null;

function DbNode({ a }: { a: Asset }) {
  const { v, open, label, service } = useMap();
  const users = new Set([...v.inc(a.id, 'env'), ...v.inc(a.id, 'uses')].map((e) => e.source)).size;
  const live = liveOf(a);
  const bad = v.attention(a); // open to the internet already shows as the red mark on its ring
  const eng = engineOf(a, service(a)?.stack);
  return (
    <HoverCard content={<DbHover a={a} />}>
      <button type="button" onClick={() => open(a.id)} aria-label={`${label(a)}: ${providerName(eng)}${a.exposed ? ', open to the internet' : ''}`}
        className="flex h-full w-full items-center gap-2.5 rounded-full pr-2 text-left transition hover:bg-surface/80">
        <DbMark a={a} sizeOf={dbSize(a)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium tracking-[-0.01em]">{label(a)}</span>
          <span className="block truncate text-[11.5px] text-muted">{dbSize(a) ? bytes(dbSize(a)) : providerName(eng)}{users ? ` · ${plural(users, 'user')}` : ' · unused'}</span>
        </span>
        {bad ? <StatusDot tone={live?.tone === 'bad' ? 'bad' : 'warn'} label={live?.text ?? 'Needs a look'} /> : null}
      </button>
    </HoverCard>
  );
}

function DbHover({ a }: { a: Asset }) {
  const { v, label, service } = useMap();
  const eng = engineOf(a, service(a)?.stack);
  const users = [...new Map([...v.inc(a.id, 'env'), ...v.inc(a.id, 'uses')].map((e) => [e.source, v.byId.get(e.source)!])).values()].filter(Boolean);
  const where = a.provider === 'unit7' || a.owner ? 'On your server' : `On ${providerName(a.provider)}`;
  return (
    <div className="w-[270px] space-y-2.5">
      <div className="flex items-center gap-2.5">
        <DbMark a={a} sizeOf={dbSize(a)} />
        <div className="min-w-0"><p className="truncate text-[14px] font-semibold">{label(a)}</p><p className="text-[12px] text-muted">{providerName(eng)}{a.version ? ` ${a.version}` : ''} · {where}</p></div>
      </div>
      <Facts rows={[
        ['Size', dbSize(a) ? bytes(dbSize(a)) : 'Not known yet'],
        ['Used by', users.length ? users.slice(0, 3).map(label).join(', ') + (users.length > 3 ? ` +${users.length - 3}` : '') : 'Nothing yet'],
        ['Backups', a.backups ? `${plural(a.backups.count, 'backup')}${a.backups.last ? `, last ${timeAgo(a.backups.last)}` : ''}` : a.provider === 'unit7' ? 'None yet' : a.provider === 'supabase' || a.provider === 'neon' ? `Kept by ${providerName(a.provider)}` : undefined],
        ['Internet', a.exposed ? <span className="font-medium text-bad">Open to anyone: its port skips the firewall</span> : a.owner ? 'Not open' : undefined],
        ['State', a.status && !/healthy|active/i.test(a.status) ? a.status.toLowerCase().replace(/_/g, ' ') : undefined],
      ]} />
      <p className="text-[12px] text-muted">Click for details</p>
    </div>
  );
}

function ServerHover({ a, f }: { a: Asset; f: MFrame }) {
  return (
    <div className="w-[250px] space-y-2">
      <p className="truncate text-[14px] font-semibold">{a.name}</p>
      <Facts rows={[['Address', a.ips?.join(', ')], ['Runs', countsWords(f) || 'Nothing found yet'], ['Seen by', [a.provider, ...(a.also ?? []).map((x) => x.provider)].filter((x, i, l) => l.indexOf(x) === i).map(providerName).join(', ')]]} />
      <p className="text-[12px] text-muted">Click for details</p>
    </div>
  );
}
