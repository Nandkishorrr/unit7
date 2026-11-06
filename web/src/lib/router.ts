// A router small enough to read: the History API plus pattern matching.
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

const subs = new Set<() => void>();
const notify = () => subs.forEach((s) => s());
window.addEventListener('popstate', notify);

export function navigate(to: string, o: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  // a new page cross-fades in (View Transitions, where the browser has them and motion is welcome); the same page
  // with new filters (replace, or only the query changing) just updates
  const page = !o.replace && to.split(/[?#]/)[0] !== location.pathname;
  history[o.replace ? 'replaceState' : 'pushState'](null, '', to);
  const swap = () => { window.scrollTo(0, 0); notify(); };
  // the new page is drawn inside the callback (flushSync), so that's the view the transition captures
  if (page && 'startViewTransition' in document && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // a transition cut short (another click, the tab hidden) rejects its promises; the page is already swapped, so that's fine
    const t = (document as Document & { startViewTransition: (f: () => void) => { ready: Promise<void>; finished: Promise<void> } }).startViewTransition(() => flushSync(swap));
    t.ready.catch(() => {}); t.finished.catch(() => {});
  } else swap();
}

export const usePath = () => useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => location.pathname);
export const useQuery = () => new URLSearchParams(useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => location.search));

// "/projects/:id" against "/projects/prj_abc" → { id: "prj_abc" }
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/'), a = path.split('/');
  if (p.length !== a.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) out[p[i]!.slice(1)] = decodeURIComponent(a[i]!);
    else if (p[i] !== a[i]) return null;
  }
  return out;
}

// intercept plain left-clicks on internal links
export function onLinkClick(e: React.MouseEvent<HTMLAnchorElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const href = e.currentTarget.getAttribute('href');
  if (!href?.startsWith('/')) return;
  e.preventDefault();
  navigate(href);
}
