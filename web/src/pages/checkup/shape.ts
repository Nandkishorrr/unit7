// The Check-up's shapes (src/care/checkup.ts) and the words around them. Pure, so a test can read them.
export type Area = 'room' | 'protection' | 'safety' | 'app';
export type Who = 'unit7' | 'your-ai' | 'you';
export type Tone = 'good' | 'look' | 'act';
export interface Fix { tool?: string; input?: Record<string, unknown>; label?: string; change?: string; safe?: boolean; manual?: string[]; ask?: string; href?: string }
export interface Item { id: string; area: Area; severity: string; title: string; why: string; who: Who; fix?: Fix; serverId?: string; evidence?: string }
export interface Checked { id: string; label: string; ok: boolean; why?: string; fix?: { tool: string; input: Record<string, unknown>; label: string } }
export interface RoomServer {
  id: string; name: string; word: string; ram: { used: number; total: number; pct: number; peakPct?: number }; cpu: { now: number; peak?: number };
  disk: { used: number; total: number; pct: number; daysLeft?: number }; projects: { id: string; name: string; mem: number; cpu: number; disk?: number }[];
}
export interface Verdict { word: string; line: string; tone: Tone }
export interface Saving { id: string; title: string; detail: string; saves: string; kind: string; risk: string; undo: string; safe: boolean; tool?: string; input?: Record<string, unknown>; label?: string; ask?: string; serverId: string }
export interface Checkup {
  id: string; at: string; by: string; ms: number; quick: boolean; level: Tone; line: string; since?: { fixed: string[]; fresh: string[]; same: number };
  verdicts: Record<Area, Verdict>; room: RoomServer[]; who?: { people: number; visitors: number; own: number; programs: number; bots: number; unit7: number }; requests?: number; topPaths?: { path: string; n: number }[]; p95?: number;
  items: Item[]; reduce: Saving[]; checked: Checked[]; blindHours: number; done: string[]; learn?: { finding: string; title: string; tool: string }[];
}
export interface History { id: string; at: string; level: Tone; line: string; by: string; ms: number | null }

export const AREA_WORDS: Record<Area, string> = { room: 'Room', protection: 'Protection', safety: 'Safety', app: 'App behaviour' };
export const WHO_WORDS: Record<Who, string> = { unit7: 'Unit7 can do this', 'your-ai': 'Your AI', you: 'Only you' };
export const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`);
// "Disk full in about 5 months", never "12%"
export const fullIn = (days?: number) => (days === undefined ? undefined : days < 45 ? `Disk full in about ${days} day${days === 1 ? '' : 's'}` : `Disk full in about ${Math.round(days / 30)} months`);
export const checkedLine = (c: Checked[]) => `Checked ${c.filter((x) => x.ok).length} of ${c.length}`;
