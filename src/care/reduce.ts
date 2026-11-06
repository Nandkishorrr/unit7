// "If it's too high, reduce it": every saving with its size, how risky it is and how to take it back, from what Unit7
// already measured. Pure: the one-click parts are ordinary tools a person runs (or "Do the safe ones", in order).
import type { Sizes, Inventory } from '../discovery/xray.ts';
import { capFor, cappable, mb } from '../discovery/findings.ts';

export interface Saving {
  id: string; title: string; detail: string; saves: string; kind: 'disk' | 'memory' | 'money'; bytes?: number; risk: 'none' | 'low' | 'some'; undo: string; safe: boolean;
  tool?: string; input?: Record<string, unknown>; label?: string; ask?: string; serverId: string;
}
export const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

export function reducePlan(o: { serverId: string; serverName: string; inv?: Inventory; sizes?: Sizes; memPeak?: Record<string, number>; memTotal?: number; memPeakServer?: number; price?: string }): Saving[] {
  const out: Saving[] = [];
  const add = (s: Omit<Saving, 'serverId'>) => out.push({ ...s, serverId: o.serverId });
  const reclaim = o.sizes?.reclaimable ?? o.inv?.disk?.reclaimable ?? 0;
  if (reclaim >= 200e6) add({ id: `reduce:images:${o.serverId}`, title: 'Remove old images and build leftovers', detail: 'Left behind by earlier deploys. Nothing that runs uses them.', saves: `Free ${size(reclaim)}`, kind: 'disk', bytes: reclaim, risk: 'low', undo: 'They rebuild on the next deploy, but a quick rollback to an old version won’t be there.', safe: true, tool: 'docker.prune', input: { serverId: o.serverId }, label: `Free ${size(reclaim)}` });
  const logs = Object.values(o.sizes?.logs ?? {}).reduce((a, b) => a + b, 0);
  if (logs >= 500e6) add({ id: `reduce:logs:${o.serverId}`, title: 'Keep logs from growing without end', detail: `Container logs take ${size(logs)}.`, saves: `Free about ${size(logs * 0.7)}`, kind: 'disk', bytes: logs * 0.7, risk: 'none', undo: 'Only old log lines go.', safe: true, tool: 'server.tidy_logs', input: { serverId: o.serverId }, label: 'Cap the logs' });
  // no cap: one leak can take everything down. The cap comes from what it really uses at its busiest, and a project's peak is
  // its one part's only when it has one part
  const parts = o.inv?.parts ?? [], workers = parts.filter((p) => ['app', 'database', 'service'].includes(p.kind));
  const uncapped = parts.filter((p) => p.kind === 'app' && p.state === 'running' && !p.memLimit && p.owner !== 'unmanaged' && p.owner !== 'systemd');
  const rest = uncapped.filter((p) => {
    const cap = workers.filter((x) => x.project === p.project).length === 1 ? capFor(o.memPeak?.[p.project ?? '']) : undefined;
    const coolify = p.coolify?.type === 'application';
    if (!cap || (!coolify && !cappable(p))) return true;
    add({ id: `reduce:cap:${o.serverId}:${p.id}`, title: `Give ${p.name} a memory cap`, detail: `${mb(cap)} is about 1.5× its busiest this week, so one leak can’t take the rest down.`, saves: 'Protects your memory', kind: 'memory', risk: 'low', undo: coolify ? 'Applies from its next deploy, and undo puts the old value back.' : 'Takes effect without a restart, and undo lifts it.', safe: false,
      tool: coolify ? 'coolify.memory_cap' : 'part.limits', input: coolify ? { serverId: o.serverId, uuid: p.coolify!.uuid, memoryMb: cap } : { serverId: o.serverId, part: p.id, memoryMb: cap }, label: `Cap at ${mb(cap)}` });
    return false;
  });
  if (rest.length) add({ id: `reduce:caps:${o.serverId}`, title: `Give ${rest.length} app${rest.length === 1 ? '' : 's'} a memory cap`, detail: 'So one leak can’t take the rest down. Unit7 needs a closer look to size these, because they share a project.', saves: 'Protects your memory', kind: 'memory', risk: 'low', undo: 'Each cap can be lifted.', safe: false,
    ask: `On my server ${o.serverName}: give each app without a memory cap a safe one (about 1.5× its busiest this week): ${rest.map((p) => p.name).join(', ')}. Show me the caps first and ask before changing anything.` });
  if (o.memTotal && o.memPeakServer && o.memPeakServer < 0.4 * o.memTotal) add({ id: `reduce:size:${o.serverId}`, title: 'A smaller server would do', detail: `At its busiest this week it used ${size(o.memPeakServer)} of ${size(o.memTotal)}.`, saves: o.price ? `Could lower your ${o.price} bill` : 'Could lower your bill', kind: 'money', risk: 'some', undo: 'You can move back up. Unit7 never changes your plan by itself.', safe: false });
  return out;
}

// A part of a stack nobody called all week. Only with a full week of windows that counted it, and only ever a suggestion.
const STACK_PARTS: [RegExp, string, string][] = [[/realtime/i, 'realtime', 'Realtime'], [/imgproxy/i, 'storage', 'Image resizing'], [/storage/i, 'storage', 'Storage'], [/functions|edge-runtime/i, 'functions', 'Edge Functions']];
export function unusedStackParts(serverId: string, serverName: string, inv: Inventory | undefined, windows: { at: string; stack?: Record<string, Record<string, number>> }[], nowMs = Date.now()): Saving[] {
  const counted = windows.filter((w) => w.stack);
  if (!counted.length || nowMs - Date.parse(counted[0]!.at) < 6.5 * 86400_000) return [];
  const out: Saving[] = [];
  for (const p of inv?.parts ?? []) {
    if (!p.internals?.length || !p.hosts?.length || !/supabase/i.test(`${p.product?.id ?? ''} ${p.name}`)) continue;
    const used = (k: string) => counted.reduce((n, w) => n + p.hosts!.reduce((m, h) => m + (w.stack?.[h]?.[k] ?? 0), 0), 0);
    if (!counted.some((w) => p.hosts!.some((h) => w.stack?.[h]))) continue; // no sign this stack's calls are being counted at all
    for (const [re, k, word] of STACK_PARTS) {
      const c = p.internals.find((x) => re.test(x.name) && x.state === 'running');
      if (!c || used(k)) continue;
      out.push({ id: `reduce:unused:${serverId}:${p.id}:${k}`, title: `${word} in ${p.name} had no calls this week`, detail: 'It uses memory and does nothing. Internal callers don’t show in this count, so check first.', saves: 'Frees its memory', kind: 'memory', risk: 'some', undo: 'Start it again in Coolify.', safe: false, serverId,
        ask: `On my server ${serverName}: ${word} in ${p.name} had no calls through the proxy this week. Check whether anything inside the stack uses it, and tell me how to turn it off safely. Don’t change anything yet.` });
    }
  }
  return out;
}
