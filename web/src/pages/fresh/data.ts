// Keep it fresh: what the server sends (tools/fresh.ts), the eight steps in plain words, and a few small helpers.
import { useEffect, useState } from 'react';
import { onLive } from '../../lib/api';

export type Mode = 'off' | 'security' | 'minor' | 'all';
export type Severity = 'critical' | 'high' | 'moderate' | 'low';
export interface Advisory { id: string; severity: Severity; summary: string; url: string; fixed?: string }
export interface Item { eco: string; name: string; from: string; to: string; bump: 'patch' | 'minor' | 'major'; dev?: boolean; direct: boolean; manager: string; security?: Advisory[] }
export interface Accept { auto: boolean; why: string }
export interface Planned { kind: string; key: string; title: string; items: Item[]; security: number; worst?: Severity; rebuild?: boolean; summary: string[]; accept: Accept }
export type StepState = 'active' | 'done' | 'failed' | 'skipped' | 'waiting' | 'todo';
export interface Step { key: string; state: StepState; at?: string; ms?: number; note?: string }
export interface Smoke { ok: boolean; line: string; rows: { path: string; live: number; copy: number; liveMs: number; copyMs: number; ok: boolean }[] }
export interface Batch {
  id: string; kind: string; key: string; status: 'planned' | 'running' | 'waiting' | 'released' | 'held' | 'rolled_back' | 'failed' | 'up_to_date'; title: string; items: Item[]; steps: Step[];
  why: string | null; createdAt: string; finishedAt: string | null; summary: string[]; notes: Record<string, string[]>; pr: { number: number; url: string; branch: string } | null;
  tests: { status: string; label?: string; failure?: string } | null; smoke: Smoke | null; preview: { url?: string } | null; deploymentId: string | null; downSeconds: number | null;
  approvalId: string | null; revertPr: { number: number; url: string; merged?: boolean } | null; diff: string; files: string; accept: Accept;
}
export interface Hold { id: string; serviceId: string | null; package: string | null; starts: string | null; until: string | null; reason: string | null; by?: string | null }
export interface AppFresh {
  serviceId: string; app: string; projectId: string; state: 'fresh' | 'waiting' | 'running' | 'held' | 'paused' | 'unchecked' | 'unsupported' | 'off'; line: string;
  mode: Mode; modeWords: string; modeOwn: boolean; level: number; levelWords: string; checkedAt: string | null; problems: string[]; source: string | null; deps: number; managers: string[];
  counts: { waiting: number; security: number; majors: number }; batches: Planned[]; held: (Item & { why: string })[]; later: Item[]; paused: { why: string; until: string | null } | null;
  base: { image: string; newer: boolean; updatedAt?: string; note?: string }[];
  schedule: { slot: string; learned: boolean; next: string | null }; current: Batch | null;
  recent: { id: string; kind: string; title: string; status: Batch['status']; why: string | null; at: string; downSeconds: number | null }[];
  holds: Hold[]; streak: { weeks: number; words: string };
}
export interface Overview {
  mode: Mode; modeWords: string; report: boolean; line: string; streak: { weeks: number; words: string }; holds: Hold[]; freeze: Hold | null;
  week: { updates: number; apps: number; security: number; downSeconds: number | null; held: string[] };
  apps: { serviceId: string; app: string; projectId: string; project: string; env: string; state: AppFresh['state']; line: string; counts: AppFresh['counts']; mode: Mode; modeOwn: boolean; level: number; next: string | null; slot: string; checkedAt: string | null; current: { id: string; status: string; title: string; why: string | null } | null }[];
}

// the eight steps, each with the one sentence that explains it
export const STEPS: { key: string; label: string; says: string }[] = [
  { key: 'find', label: 'Find', says: 'Looks for newer versions and known security problems in what your app uses.' },
  { key: 'apply', label: 'Apply', says: 'Makes the updates on their own branch, with a pull request you can read.' },
  { key: 'test', label: 'Test', says: 'Runs your app’s own tests on the updated code. A failing test stops everything here.' },
  { key: 'staging', label: 'Staging', says: 'Builds a test copy of the app with the updates, beside the live one.' },
  { key: 'check', label: 'Check', says: 'Opens your busiest pages on the copy and compares them with the live app.' },
  { key: 'accept', label: 'Accept', says: 'Goes ahead by itself, or waits for your OK, as you set it.' },
  { key: 'release', label: 'Release', says: 'Ships it with zero downtime: visitors move only once the new version answers.' },
  { key: 'watch', label: 'Watch', says: 'Watches errors and speed for a few minutes, and goes back by itself if they get worse.' },
];
export const stepsOf = (b: Pick<Batch, 'steps'> | null): Step[] => STEPS.map((s) => b?.steps.find((x) => x.key === s.key) ?? { key: s.key, state: 'todo' as const });

export const MODES: { value: Mode; label: string; short: string; says: string }[] = [
  { value: 'security', label: 'Security only', short: 'Security', says: 'Only fixes for known security problems.' },
  { value: 'minor', label: 'Patch & minor', short: 'Patch & minor', says: 'Security fixes, bug fixes and small improvements. Nothing you use is taken away.' },
  { value: 'all', label: 'Everything', short: 'Everything', says: 'Major versions too, each on its own. They wait for your OK unless Autopilot is on.' },
];
export const SEV_WORDS: Record<Severity, string> = { critical: 'Critical', high: 'Serious', moderate: 'Moderate', low: 'Minor' };
export const SEV_TONE: Record<Severity, 'bad' | 'warn' | 'neutral'> = { critical: 'bad', high: 'bad', moderate: 'warn', low: 'neutral' };
const KNOWN: Record<string, string> = { next: 'Next.js', react: 'React', 'react-dom': 'React DOM', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte', express: 'Express', django: 'Django', flask: 'Flask', fastapi: 'FastAPI', prisma: 'Prisma', '@prisma/client': 'Prisma', typescript: 'TypeScript', vite: 'Vite', tailwindcss: 'Tailwind CSS', astro: 'Astro' };
export const nice = (name: string) => KNOWN[name] ?? name;
export const major = (v: string) => v.split('.')[0];
export const ended = (s: Batch['status']) => s === 'released' || s === 'held' || s === 'rolled_back' || s === 'failed' || s === 'up_to_date';

// one batch, kept live while it runs (fresh.step events carry its steps)
export function useLiveSteps(b: Batch | null | undefined, reload: () => void) {
  const [steps, setSteps] = useState(b?.steps);
  useEffect(() => setSteps(b?.steps), [b?.id, b?.steps]);
  useEffect(() => onLive((e) => {
    if (!b || (e.data as { batch?: string } | undefined)?.batch !== b.id) return;
    if (e.type === 'fresh.step') { setSteps((e.data as { steps: Step[] }).steps); if ((e.data as { status?: string }).status && ended((e.data as { status: Batch['status'] }).status)) reload(); }
    else if (/^fresh\.(released|held|ready)$/.test(e.type)) reload();
  }), [b?.id, reload]);
  return steps;
}
export function fmtDate(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
export function fmtWhen(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { weekday: 'long' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
