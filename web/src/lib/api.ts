import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// The second half of the session (the cookie is the first): localhost cookies reach every port on this
// computer, this page's storage doesn't, so the server only trusts the cookie together with this.
const BIND = 'unit7.session';
let held = ''; // when storage is blocked: signed in for this page only
const bind = () => { try { return localStorage.getItem(BIND) ?? held; } catch { return held; } };

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), 'x-unit7-bind': bind() },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  });
  const tag = res.headers.get('x-unit7-bind');
  if (tag) held = tag; else if (path === '/api/auth/logout') held = '';
  try { if (tag) localStorage.setItem(BIND, tag); else if (path === '/api/auth/logout') localStorage.removeItem(BIND); } catch { /* blocked storage */ }
  const data = await res.json().catch(() => null);
  if (!res.ok && !(path.startsWith('/api/tools/') && data?.status)) {
    throw new ApiError(data?.error?.code ?? 'http_error', data?.error?.message ?? `Request failed (${res.status}).`, res.status);
  }
  return data as T;
}

// --- live events: one SSE connection, many listeners ---
export interface LiveEvent { id: string; type: string; severity: 'info' | 'success' | 'warning' | 'critical'; message: string; data: any; created_at: string; live?: boolean; project_id?: string | null; environment_id?: string | null; resource?: string | null
  explain?: { what: string; why: string; next: string; advanced?: string } } // plain words, from /api/events (src/explain.ts)
type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | undefined;
let connected = false;
const connListeners = new Set<() => void>();

export function startLive() {
  if (source) return;
  source = new EventSource(`/api/stream?bind=${encodeURIComponent(bind())}`);
  source.onopen = () => { connected = true; connListeners.forEach((l) => l()); };
  source.onerror = () => { connected = false; connListeners.forEach((l) => l()); };
  source.onmessage = (m) => {
    const e = JSON.parse(m.data) as LiveEvent;
    listeners.forEach((l) => l(e));
  };
}
export function stopLive() { source?.close(); source = undefined; connected = false; }
export const onLive = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useConnected = () => useSyncExternalStore((cb) => { connListeners.add(cb); return () => connListeners.delete(cb); }, () => connected);

// --- data hook: fetch, then refetch when something changes (debounced on live events) ---
export function useApi<T = any>(path: string | null, o: { live?: boolean | ((e: LiveEvent) => boolean) } = { live: true }) {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: !!path });
  const pathRef = useRef(path);
  pathRef.current = path;
  const load = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    try {
      const data = await api<T>(p);
      if (pathRef.current === p) setState({ data, loading: false });
    } catch (e) {
      if (pathRef.current === p) setState((s) => ({ ...s, error: e as ApiError, loading: false }));
    }
  }, []);
  useEffect(() => {
    setState((s) => ({ data: s.data, loading: true }));
    void load();
  }, [path, load]);
  useEffect(() => {
    if (!o.live) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((e) => {
      if (e.live && e.type !== 'agent.done' && e.type !== 'map.rechecked') return;
      if (typeof o.live === 'function' && !o.live(e)) return;
      clearTimeout(t);
      t = setTimeout(load, 250);
    });
    return () => { off(); clearTimeout(t); };
  }, [o.live, load]);
  return { ...state, reload: load };
}

// --- tools: the one write path ---
export type ToolResult =
  | { status: 'ok'; output: any; auditId: string; durationMs: number }
  | { status: 'dry_run'; plan: any; auditId: string }
  | { status: 'approval_required'; approvalId: string; why: string }
  | { status: 'denied'; why: string }
  | { status: 'error'; error: { code: string; message: string; logTail?: string } }; // logTail: a log kept apart from the plain message (Show details)

export const runTool = (name: string, input: unknown = {}, o: { dryRun?: boolean; reason?: string } = {}) =>
  api<ToolResult>(`/api/tools/${name}`, { body: { input, ...o } });
