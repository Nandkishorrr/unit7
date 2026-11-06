// What the care pieces read: one read tool, refetched (at most every few seconds) when Unit7 records something new.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { onLive, runTool, type LiveEvent } from '../../lib/api';

export type Fix = { tool: string; input: Record<string, unknown>; label: string } | { href: string; label: string } | { ask: string; label: string };
export interface Check { key: string; label: string; ok: boolean; detail: string; fix?: Fix }
export interface Readiness { projectId: string; name: string; done: number; total: number; ready: boolean; checks: Check[] }
export type ReadinessSummary = Omit<Readiness, 'checks'>;

export interface Line { key: string; name: string; amount: number; estimate?: boolean; provider?: string; projectId?: string; note?: string }
export interface LifecycleItem { key: string; name: string; kind: string; provider?: string; projectId?: string }
export type SaveAction = { kind: 'lifecycle'; item: LifecycleItem } | { kind: 'tool'; tool: string; input: Record<string, unknown>; label: string } | { kind: 'open'; href: string; label: string };
export interface Saving { id: string; kind: 'idle' | 'oversized' | 'duplicate' | 'cleanup'; title: string; detail: string; amount: number | null; action: SaveAction }
export interface Radar {
  currency: string; month: string; total: number; soFar: number; lastMonth: number | null; budget: number | null; estimate: boolean;
  byProvider: Line[]; byProject: Line[]; byClient: Line[]; savings: Saving[]; save: number; notes: string[]; checkedAt: string | null;
}

// events that can change what these show (not progress lines, not chat tokens)
const matters = (e: LiveEvent) => !e.live && !/^(agent|tool)\./.test(e.type);

export function useTool<T>(name: string, input: Record<string, unknown> | null) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const key = input ? JSON.stringify(input) : null;
  const ref = useRef(key);
  ref.current = key;
  const load = useCallback(async (extra: Record<string, unknown> = {}) => {
    const k = ref.current;
    if (k === null) return;
    try {
      const r = await runTool(name, { ...JSON.parse(k), ...extra });
      if (ref.current !== k) return;
      if (r.status === 'ok') setState({ data: r.output as T });
      else setState((s) => ({ ...s, error: r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : 'Waiting for approval' }));
    } catch (e) { if (ref.current === k) setState((s) => ({ ...s, error: (e as Error).message })); }
  }, [name]);
  useEffect(() => { setState({}); void load(); }, [key, load]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((e) => { if (matters(e)) { clearTimeout(t); t = setTimeout(() => void load(), 2500); } });
    return () => { off(); clearTimeout(t); };
  }, [load]);
  return { ...state, reload: load };
}

// every project's score, fetched once for all the cards on a page
let all: ReadinessSummary[] | undefined, loading: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined, offLive: (() => void) | undefined;
const subs = new Set<() => void>();
function loadAll() {
  loading ??= runTool('project.readiness', {}).then((r) => { if (r.status === 'ok') { all = (r.output as { projects: ReadinessSummary[] }).projects; subs.forEach((f) => f()); } })
    .catch(() => {}).finally(() => { loading = undefined; });
  return loading;
}
function subscribe(f: () => void) {
  subs.add(f);
  if (!all) void loadAll();
  offLive ??= onLive((e) => { if (matters(e)) { clearTimeout(timer); timer = setTimeout(() => void loadAll(), 3000); } });
  return () => { subs.delete(f); };
}
export const refreshReadiness = () => loadAll();
export function useReadinessOf(projectId: string): ReadinessSummary | undefined {
  return useSyncExternalStore(subscribe, () => all)?.find((p) => p.projectId === projectId);
}

// whole amounts and big ones without cents ($116, $24), the rest with both digits ($5.52, $71.50)
export const money = (n: number, currency: string, o: { cents?: boolean } = {}) => {
  const d = o.cents === false || n >= 100 || Number.isInteger(n) ? 0 : 2;
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: d, minimumFractionDigits: d }).format(n); }
  catch { return `${n.toFixed(0)} ${currency}`; }
};
