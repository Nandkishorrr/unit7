// What the server watch tools return (server.trends, server.findings, server.traffic, watch.anomalies,
// watch.settings), and the plain formatting the watch pieces share.
import type { Finding } from '../security/SecurityCheck';

export type Metric = 'cpu' | 'mem' | 'net';
export interface TPoint { at: string; cpu: number | null; cpuMax?: number | null; mem: number | null; memMax?: number | null; net: number | null; restarts: number; oom: number; disk?: number | null }
export interface TBand { lo: number | null; hi: number | null; mid: number | null }
export interface TSeries { scope: string; name: string; system?: boolean; points: TPoint[]; band: Record<Metric, (TBand | null)[]> }
export interface Mark { at: string; kind: 'deploy' | 'restart' | 'oom' | 'change' | 'alert'; label: string; scope?: string }
export interface WAlert {
  id: string; serverId: string; serverName?: string; source: 'usage' | 'traffic' | 'finding'; key: string; severity: string; title: string; since: string; lastSeen: string; cleared: string | null;
  scope?: string; name?: string; kind?: string; metric?: string; started?: string; fix?: Finding['fix']; incidentId?: string; conversationId?: string;
  snoozeKey?: string; explain?: Finding['explain']; // what "This is fine" hides; plain words
}
export interface Trends { blind?: { from: string; to: string }[]; serverId: string; serverName: string; range: Range; res: string; at: string; cpus?: number; memTotal?: number; diskTotal?: number; series: TSeries[]; events: Mark[]; anomalies: WAlert[]; learning: boolean; next?: string; note?: string }
export type Range = '6h' | '24h' | '7d' | '30d' | '1y';
export type WFinding = Finding & { bucket: 'risk' | 'waste' | 'tip' };
export interface FindingsOut { serverId: string; serverName: string; at: { xray?: string; sizes?: string; traffic?: string }; counts: { risks: number; waste: number; tips: number }; risks: WFinding[]; waste: WFinding[]; tips: WFinding[]; notes: string[] }
export interface Summary {
  at: string; minutes: number; requests: number; ips: number; status: { s2xx: number; s3xx: number; s4xx: number; s5xx: number }; p95?: number;
  who?: { people: number; visitors: number; own: number; programs: number; bots: number; unit7: number };
  topPaths: { path: string; n: number; s4xx: number; s5xx: number }[]; topAgents: { agent: string; n: number; bot: boolean }[];
  topIps: { ip: string; n: number; anon: number; logins: number; scans: number; s4xx: number }[]; hosts: { host: string; n: number; s5xx: number }[];
  bots: number; scanners: { n: number; ips: number }; logins: { n: number; failed: number; ips: number }; anon: { n: number; ips: number; how: 'headers' | 'refused' };
  errors: { container: string; n: number; sample: string[] }[]; sources: { id: string; name: string; lines: number; note?: string }[];
}
export interface TrafficOut {
  serverId: string; serverName: string; at: string; minutes: number; every: number; summary: Summary; findings: WFinding[];
  usual: { requests?: number; s4xx?: number; s5xx?: number; anon?: number; ips?: number }; history: { at: string; minutes: number; requests: number; s5xx: number; s4xx: number; anon: number }[];
  stale?: { since: string; why: string };
}
export interface WatchSettingsOut { every: 30 | 60; usage: boolean; traffic: boolean; logs: boolean; findings: boolean; digest: boolean; investigate: boolean; investigateReady?: boolean; quiet: { from: string; to: string; tz?: string } | null; tz?: string; sampleEvery: number; lastDigest: string | null; channels: string[]; brief?: boolean }

// --- words and numbers ---
export const bytes = (n?: number | null) => {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  return a >= 1e12 ? `${(n / 1e12).toFixed(1)} TB` : a >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : a >= 1e6 ? `${Math.round(n / 1e6)} MB` : a >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${Math.round(n)} B`;
};
export const rate = (n?: number | null) => (n == null ? '–' : `${bytes(n)}/s`);
export const pct = (n?: number | null) => (n == null ? '–' : `${n >= 10 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, '')}%`);
export const count = (n?: number | null) => (n == null ? '–' : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
export const METRIC: Record<Metric, { label: string; short: string; fmt: (n?: number | null) => string }> = {
  cpu: { label: 'CPU', short: 'CPU', fmt: pct }, mem: { label: 'Memory', short: 'Memory', fmt: bytes }, net: { label: 'Network', short: 'Network', fmt: rate },
};
export const clock = (iso: string, range: Range) => {
  const d = new Date(iso);
  return range === '6h' || range === '24h' ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : range === '1y' ? d.toLocaleDateString([], { month: 'short', year: '2-digit' }) : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
};
export const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
export const sevTone = (s: string): 'bad' | 'warn' | 'info' => (s === 'critical' || s === 'high' ? 'bad' : s === 'warning' || s === 'medium' ? 'warn' : 'info');
// server.traffic_series: visits per hour (24h, 7d) or day (30d), each with its usual band, and the range's totals
export type TrafficRange = '24h' | '7d' | '30d';
export interface TrafficPoint { at: string; minutes: number; visits: number | null; errors: number; refused: number; anon: number; band: { lo: number; mid: number; hi: number } | null }
export interface TrafficSeriesOut {
  serverId: string; serverName: string; at: string; lastCheck?: string; range: TrafficRange; step: '1h' | '1d'; points: TrafficPoint[];
  totals: { visits: number; errors: number; refused: number; anon: number; checks: number; minutes: number }; usual?: number;
  topPaths: { path: string; n: number; errors: number }[]; callers: { people: number; bots: number; scanners: number }; agents: { agent: string; n: number; bot: boolean }[];
  deploys: Mark[];
}
