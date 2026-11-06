// Products and clients, for every page: one shared fetch of client.list (refreshed when a client, a product or a status
// page changes), the client the person picked to filter by (remembered on this computer), and the shapes map.get and
// group.suggest send.
import { useSyncExternalStore } from 'react';
import { onLive, runTool } from '../../lib/api';

export type Health = 'ok' | 'warn' | 'bad';
export interface Cost { currency: string; amount: number }
export interface ClientMember { key: string; name: string; kind: string; logos: string[]; count?: number }
export interface Client {
  id: string; name: string; color: string; logo: string | null; contact: string | null;
  products: number; projects: number; things: number; health: Health; cost: Cost[]; members: ClientMember[];
  statusPage: { on: boolean; domain?: string; updatedAt?: string; problem?: string }; ids: string[];
}
export interface ClientList { month: string; clients: Client[]; mine: { products: number; projects: number; cost: Cost[] } }

export type Signal = 'env' | 'dns' | 'repo' | 'name';
export interface SuggestionItem { key: string; name: string; kind: string; provider: string; logo: string; signal: Signal; reason: string }
export interface GroupSuggestion { id: string; name: string; confidence: 'strong' | 'good' | 'maybe'; signals: Signal[]; items: SuggestionItem[]; into?: { id: string; name: string } }
export interface ProductMember { key: string; name: string; kind: string; provider: string; logo: string; reason: string | null }
export interface Product { id: string; name: string; auto: boolean; createdAt: string; health: Health; members: ProductMember[]; client?: { id: string; name: string; color: string | null } }
export interface Suggested { suggestions: GroupSuggestion[]; groups: Product[]; projects: { id: string; name: string; groupId?: string }[] }
// map.get adds these for the Map's frames: `group` (a product id) on each asset in one, and `groups` (absent while there are none)
export interface MapGroup { id: string; name: string; auto: boolean; health: Health; members: string[]; projects: string[]; client?: { id: string; name: string; color: string | null } }

export const HEALTH_WORDS: Record<Health, string> = { ok: 'All good', warn: 'Needs a look', bad: 'Something’s down' };
export const HEALTH_DOT: Record<Health, 'ok' | 'warn' | 'bad'> = { ok: 'ok', warn: 'warn', bad: 'bad' };
export const money = (c: Cost[]) => (c.length ? c.map((x) => new Intl.NumberFormat(undefined, { style: 'currency', currency: x.currency, maximumFractionDigits: x.amount < 100 ? 2 : 0 }).format(x.amount)).join(' + ') : '—');
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

// --- the shared list ------------------------------------------------------------------------------------------------------
let list: ClientList | undefined;
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());
export function reloadClients() {
  loading ??= runTool('client.list').then((r) => { if (r.status === 'ok') { list = r.output as ClientList; ids = undefined; tell(); } }).catch(() => {}).finally(() => { loading = null; });
  return loading;
}
const touches = (e: { type: string; data?: any }) => /^(client|group|status)\./.test(e.type) || (/^action\./.test(e.type) && /^(client|group)\./.test(String(e.data?.tool ?? '')));
let offLive: (() => void) | undefined;
function subscribe(f: () => void) {
  subs.add(f);
  if (!list) void reloadClients();
  offLive ??= onLive((e) => { if (!e.live && touches(e)) void reloadClients(); });
  return () => { subs.delete(f); };
}
export const useClients = () => useSyncExternalStore(subscribe, () => list);

// --- the filter: All, one client, or "My own" (what no client has) -------------------------------------------------------------
const KEY = 'unit7-client';
let picked: string | null = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
let ids: { of: Map<string, Set<string>>; any: Set<string> } | undefined;
const idsOf = () => (ids ??= { of: new Map((list?.clients ?? []).map((c) => [c.id, new Set(c.ids)])), any: new Set((list?.clients ?? []).flatMap((c) => c.ids)) });
export function pickClient(id: string | null) {
  picked = id;
  try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* private mode */ }
  tell();
}
const snap = () => `${picked ?? ''}|${list ? 1 : 0}`;
// pages call has(id) with any id they show (prj_, svc_, srv_, ast_, grp_): true when it belongs to the picked client
export function useClientFilter() {
  useSyncExternalStore(subscribe, snap);
  const l = useSyncExternalStore(subscribe, () => list);
  const clients = l?.clients ?? [];
  const current = picked === 'mine' ? 'mine' : clients.find((c) => c.id === picked)?.id ?? null; // a removed client falls back to All
  const has = (id: string | null | undefined) => {
    if (!current || !id) return true;
    const x = idsOf();
    return current === 'mine' ? !x.any.has(id) : !!x.of.get(current)?.has(id);
  };
  return { picked: current, client: clients.find((c) => c.id === current), clients, active: !!current, has, pick: pickClient };
}
