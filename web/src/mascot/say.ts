// What Warden's speech bubble says, as plain functions (no React), so a test can hold them to it.

export interface SayItem { id: string; severity: 'info' | 'warn' | 'alert'; text: string }
export interface Say { keys: string[]; text: string; tone: 'bad' | 'warn' | 'info' }

// one short line from a suggestion: its first clause, at most about a line long
// ("srv1's doors aren't checked yet: password logins…" → "srv1's doors aren't checked yet")
export function shortLine(text: string, max = 64): string {
  const t = (text.split(/(?<=[.!?])\s|:\s/)[0] ?? text).trim().replace(/[.!]$/, '');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// The next thing worth saying, or null. Each suggestion is said at most once (`seen`, kept for the session). The first
// time in a session with two or more things to look at, it's one line for all of them ("3 things need a look"); after
// that, each new one on its own, most urgent first (the list comes sorted that way).
export function nextSay(items: SayItem[], seen: ReadonlySet<string>): Say | null {
  const fresh = items.filter((s) => s.id !== 'all-clear' && !seen.has(s.id));
  if (!fresh.length) return null;
  const todo = fresh.filter((s) => s.severity !== 'info');
  if (!seen.size && todo.length >= 2) {
    return { keys: fresh.map((s) => s.id), text: `${todo.length} things need a look`, tone: todo.some((s) => s.severity === 'alert') ? 'bad' : 'warn' };
  }
  const top = fresh[0]!;
  return { keys: [top.id], text: shortLine(top.text), tone: top.severity === 'alert' ? 'bad' : top.severity === 'warn' ? 'warn' : 'info' };
}

// "What Warden did today", in one line, from the record of what it did (its own changes, not its reads)
export interface DidRow { tool: string; risk?: string; result?: string; created_at: string; agent?: string | null; actor_name?: string }
export function didToday(rows: DidRow[], words: (tool: string) => string, now = new Date()): string {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const mine = rows.filter((r) => (r.agent === 'Warden' || r.actor_name === 'Warden') && r.result === 'success' && r.risk !== 'read' && new Date(r.created_at) >= start);
  if (!mine.length) return 'A quiet day so far. I’m keeping watch.';
  const last = [...mine].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]!;
  return `Today I took care of ${mine.length} thing${mine.length === 1 ? '' : 's'}. Last: ${words(last.tool).toLowerCase()}.`;
}
