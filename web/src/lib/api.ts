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
  const form = init.body instanceof FormData; // files: the browser writes its own content type
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(init.body === undefined || form ? {} : { 'content-type': 'application/json' }), 'x-unit7-bind': bind() },
    body: form ? (init.body as FormData) : init.body === undefined ? undefined : JSON.stringify(init.body),
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

const refused = async (res: Response) => { const data = await res.json().catch(() => null); return new ApiError(data?.error?.code ?? 'http_error', data?.error?.message ?? `Request failed (${res.status}).`, res.status); };
// a file off a server, saved by the browser: a plain link can't carry the session's header
export async function saveDownload(path: string, name: string) {
  const res = await fetch(path, { headers: { 'x-unit7-bind': bind() }, credentials: 'same-origin' });
  if (!res.ok) throw await refused(res);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
// a file's bytes to Unit7 first (100 MB at most): file.upload then puts them on the server
export async function sendFile(file: File): Promise<string> {
  const res = await fetch('/api/uploads', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-unit7-bind': bind() }, body: file, credentials: 'same-origin' });
  if (!res.ok) throw await refused(res);
  return (await res.json()).uploadId;
}
// a file for a tool to use (part.import, wordpress.import): the raw bytes, then the tool gets its id. XHR, because fetch can't say how
// far an upload has got
export function upload(file: File, onProgress?: (share: number) => void): Promise<{ uploadId: string; size: number }> {
  return new Promise((done, no) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/uploads');
    x.responseType = 'json';
    x.setRequestHeader('content-type', 'application/octet-stream');
    x.setRequestHeader('x-unit7-bind', bind());
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? done(x.response) : no(new ApiError(x.response?.error?.code ?? 'http_error', x.response?.error?.message ?? `The upload failed (${x.status}).`, x.status)));
    x.onerror = () => no(new ApiError('http_error', 'The file didn’t reach Unit7. Check that Unit7 is running, and try again.', 0));
    x.send(file);
  });
}

// --- live events: one SSE connection, many listeners ---
export interface LiveEvent { id: string; type: string; severity: 'info' | 'success' | 'warning' | 'critical'; message: string; data: any; created_at: string; live?: boolean; project_id?: string | null; environment_id?: string | null; resource?: string | null
  explain?: { what: string; why: string; next: string; advanced?: string } } // plain words, from /api/events (src/explain.ts)
type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | undefined;
let connected = false;
const connListeners = new Set<() => void>();

// a page the browser keeps for Back would hold its stream open, and six of those are every connection it gives this host: the next
// page's requests then wait forever
window.addEventListener('pagehide', () => { source?.close(); source = undefined; });
window.addEventListener('pageshow', (e) => { if (e.persisted) startLive(); });

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
