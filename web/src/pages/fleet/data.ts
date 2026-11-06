// What the fleet pieces read: fleet.get (an app's servers, versions, rollout) and fleet.readiness, through care's useTool
// (refetched when Unit7 records something new). While a rollout runs, the lanes are polled every 2 seconds.
import { useEffect } from 'react';
import { useTool } from '../care/data';
import type { Check } from '../care/data';

export type LaneState = 'waiting' | 'running' | 'done' | 'failed' | 'undone' | 'skipped';
export type StepKey = 'image' | 'start' | 'check' | 'switch' | 'done';
export interface Lane { serverId: string; name: string; primary: boolean; state: LaneState; step?: StepKey; detail?: string }
export interface Run { status: 'running' | 'paused' | 'cancelling' | 'done' | 'failed' | 'cancelled'; batch: number; lanes: Lane[]; error: string | null; by: string | null; startedAt: string; finishedAt: string | null }
export interface FleetServer { serverId: string; name: string; host: string; status: string; primary: boolean; role?: 'primary' | 'replica' | 'standby'; state: 'in' | 'out' | 'sick'; health: 'ok' | 'bad' | null; checkedAt: string | null; version: number | null; share: number; private: boolean }
// D3: a new version tried on some visitors first
export interface CanaryPoint { at: string; newRate: number | null; oldRate: number | null; newReq: number; oldReq: number; newP95?: number; oldP95?: number; share: number }
export interface Canary {
  id: string; status: 'starting' | 'running' | 'held' | 'done' | 'rolled_back' | 'failed'; share: number; steps: number[]; step: number; holdMinutes: number; version: number | null; from: number | null;
  next?: number; nextAt: string | null; points: CanaryPoint[]; words: string; reason: string | null; by: string | null; startedAt: string; finishedAt: string | null;
}
export const canaryLive = (c: Canary | null | undefined) => !!c && (c.status === 'starting' || c.status === 'running' || c.status === 'held');
export interface Fleet {
  serviceId: string; name: string; kind: string; deployed: boolean; many: boolean; mode: 'single' | 'front' | 'dns'; why: string | null;
  servers: FleetServer[]; drift: { same: boolean; main: number | null; behind: string[]; words?: string };
  run: Run | null; readiness: { done: number; total: number; ready: boolean };
  candidates: { serverId: string; name: string; ready: boolean }[];
  words: { rolling: string; rotation: string; front: string; canary?: string };
  canary?: Canary | null; canaryWhyNot?: string | null;
}
export interface FleetReadiness { serviceId: string; name: string; done: number; total: number; ready: boolean; checks: Check[] }

export const running = (r: Run | null | undefined) => !!r && (r.status === 'running' || r.status === 'paused' || r.status === 'cancelling');

export function useFleet(serviceId: string) {
  const f = useTool<Fleet>('fleet.get', { serviceId });
  const live = running(f.data?.run) || canaryLive(f.data?.canary);
  // a rollout moves every few seconds; a canary only between its looks (Warden's minute), so it's asked less often
  const every = running(f.data?.run) ? 2000 : 10_000;
  useEffect(() => { if (!live) return; const t = setInterval(() => void f.reload(), every); return () => clearInterval(t); }, [live, every, f.reload]);
  return f;
}

// the words, explained once per browser, then only on hover
export function firstTime(key: string) {
  try { if (localStorage.getItem(`unit7-word:${key}`)) return false; localStorage.setItem(`unit7-word:${key}`, '1'); return true; } catch { return false; }
}
