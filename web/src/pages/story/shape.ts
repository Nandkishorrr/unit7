// What story.timeline, story.replay and story.brief return (src/story/*), and the small helpers the cards share:
// lines grouped by day, the clock, who did it, and how each kind of change looks.
import { Bot, Box, Check, Cpu, Globe, History, KeyRound, Link2, RotateCcw, RotateCw, Rocket, ScanEye, Server, ShieldCheck, Wrench, type LucideIcon } from 'lucide-react';

export type Kind = 'deploy' | 'rollback' | 'setting' | 'dns' | 'change' | 'found' | 'restart' | 'link' | 'security' | 'server' | 'approval' | 'other';
export type WhoKind = 'person' | 'ai' | 'warden' | 'unit7' | 'outside';
export interface Who { kind: WhoKind; name: string }
export interface Undo { tool: string; input: Record<string, unknown>; label: string }
export interface Item {
  id: string; at: string; kind: Kind; text: string; who: Who; logo?: string; status?: 'ok' | 'failed' | 'undone' | 'working';
  undo?: Undo; detail?: string[]; children?: Item[]; serverId?: string; serviceId?: string; projectId?: string; culprit?: boolean;
}
export interface Health { state: 'ok' | 'failing'; healthyAt?: string; failingSince?: string; recoveredAt?: string; what?: string; guessed?: boolean }
export interface TimelineOut { scope: { label: string; serverId?: string; projectId?: string; serviceId?: string }; since: string; until: string; items: Item[]; health?: Health; culpritId?: string; mode: 'all' | 'since-healthy'; leadMinutes?: number }

export type Rule = 'oom_loop' | 'oom' | 'bad_deploy' | 'traffic_spike' | 'restart_loop' | 'change' | 'cpu' | 'disk' | 'errors' | 'unknown';
export interface Cause { rule: Rule; text: string; at?: string; itemId?: string; confidence: 'high' | 'medium' | 'low' | 'none' }
export interface Bucket { at: string; requests: number | null; errors: number | null; cpu: number | null; mem: number | null; restarts: number; oom: number }
export interface Marker { at: string; kind: 'deploy' | 'change' | 'restart' | 'oom' | 'failure' | 'recovery'; label: string; itemId?: string }
export interface StoryOut {
  at: string; from: string; to: string; title: string; scope: { label: string; serverId?: string; serviceId?: string; incidentId?: string };
  cause: Cause; buckets: Bucket[]; memCap: number | null; coarse: boolean; markers: Marker[]; changes: Item[];
  errors: { source: string; lines: string[] }[]; untrusted: true; aiContext: string;
}
export interface BriefLine { key: 'yesterday' | 'fixed' | 'decision' | 'fine' | 'blind'; text: string; href?: string }
export interface BriefOut { day: string; lines: BriefLine[]; fine: boolean; text: string; on: boolean; sentAt: string | null; empty?: boolean }

// --- time -------------------------------------------------------------------------------------------------------
export const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const longWhen = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
export function dayLabel(iso: string, now = new Date()) {
  const d = new Date(iso), y = new Date(now); y.setDate(y.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return 'Today';
  if (dayKey(d) === dayKey(y)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}
// newest first in, days newest first out (each day's lines keep their order)
export function byDay<T extends { at: string }>(items: T[], now = new Date()): { day: string; items: T[] }[] {
  const out: { day: string; items: T[] }[] = [];
  for (const it of items) {
    const day = dayLabel(it.at, now);
    const last = out.at(-1);
    if (last?.day === day) last.items.push(it); else out.push({ day, items: [it] });
  }
  return out;
}

// --- how each line looks ------------------------------------------------------------------------------------------
export const KIND: Record<Kind, { icon: LucideIcon; word: string; tone: 'blue' | 'soft' | 'neutral' | 'lime' | 'warn' | 'ok' | 'dark' }> = {
  deploy: { icon: Rocket, word: 'Deploy', tone: 'blue' }, rollback: { icon: RotateCcw, word: 'Roll back', tone: 'soft' },
  setting: { icon: KeyRound, word: 'Setting', tone: 'neutral' }, dns: { icon: Globe, word: 'Domain', tone: 'soft' },
  change: { icon: Wrench, word: 'Change', tone: 'neutral' }, found: { icon: ScanEye, word: 'Seen on the server', tone: 'neutral' },
  restart: { icon: RotateCw, word: 'Restart', tone: 'neutral' }, link: { icon: Link2, word: 'Connection', tone: 'neutral' },
  security: { icon: ShieldCheck, word: 'Safety', tone: 'lime' }, server: { icon: Server, word: 'Server', tone: 'neutral' },
  approval: { icon: Check, word: 'Decision', tone: 'ok' }, other: { icon: Box, word: 'Change', tone: 'neutral' },
};
export const WHO: Record<WhoKind, { icon: LucideIcon; word: string }> = {
  person: { icon: History, word: 'A person' }, ai: { icon: Bot, word: 'An AI' }, warden: { icon: ShieldCheck, word: 'Warden, Unit7’s watchdog' },
  unit7: { icon: Cpu, word: 'Unit7 by itself' }, outside: { icon: ScanEye, word: 'Seen from outside Unit7' },
};
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

// the filters: plain groups of kinds
export const KIND_FILTER: { value: string; label: string; kinds?: Kind[] }[] = [
  { value: 'all', label: 'Everything' }, { value: 'deploys', label: 'Deploys', kinds: ['deploy', 'rollback'] }, { value: 'settings', label: 'Settings', kinds: ['setting'] },
  { value: 'domains', label: 'Domains', kinds: ['dns'] }, { value: 'server', label: 'On the server', kinds: ['change', 'found', 'restart', 'server', 'other', 'link'] },
  { value: 'safety', label: 'Safety', kinds: ['security', 'approval'] },
];
export const WHO_FILTER: { value: string; label: string; who?: WhoKind[] }[] = [
  { value: 'all', label: 'Anyone' }, { value: 'people', label: 'People', who: ['person'] }, { value: 'ai', label: 'AI', who: ['ai'] }, { value: 'unit7', label: 'Unit7', who: ['warden', 'unit7'] }, { value: 'outside', label: 'Outside Unit7', who: ['outside'] },
];
export function filterItems(items: Item[], kind: string, who: string): Item[] {
  const k = KIND_FILTER.find((f) => f.value === kind)?.kinds, w = WHO_FILTER.find((f) => f.value === who)?.who;
  return items.filter((it) => (!k || k.includes(it.kind)) && (!w || w.includes(it.who.kind)));
}

// --- the replay strip ---------------------------------------------------------------------------------------------
export const CONFIDENCE: Record<Cause['confidence'], string> = { high: 'Very likely', medium: 'Likely', low: 'Possibly', none: 'No clear cause' };
export const MARK: Record<Marker['kind'], { color: string; word: string }> = {
  deploy: { color: 'var(--blue)', word: 'Deploy' }, change: { color: 'var(--ink)', word: 'Change' }, restart: { color: '#f59e0b', word: 'Restart' },
  oom: { color: 'var(--bad)', word: 'Out of memory' }, failure: { color: 'var(--bad)', word: 'Failure' }, recovery: { color: 'var(--ok)', word: 'Back up' },
};
export const mb = (n?: number | null) => (n == null ? '–' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
