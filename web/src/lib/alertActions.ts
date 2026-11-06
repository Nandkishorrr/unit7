// Every alert gets a way forward, whatever it came from (a map issue, a server risk, a site check, a Home task):
// its own fix when there is one, always "Check again" (re-runs the one check behind it, read-only, no approval), and
// "Ask Unit7 to fix it" when no fix really fixes it. Pure, so it's tested on its own.

export interface AlertFix { tool: string; input: Record<string, unknown>; label: string; change?: string; typeName?: string; success?: string; look?: boolean }
export type AlertAction =
  | { kind: 'fix'; fix: AlertFix }
  | { kind: 'check'; label: string }
  | { kind: 'ask'; label: string; prompt: string }
  | { kind: 'open'; label: string; href: string };

export interface AlertLike { text: string; fix?: AlertFix | AlertFix[] | null; ask?: string; open?: { label: string; href: string } }

export const askFallback = (text: string) => `${text.trim().replace(/[.!]+$/, '')}. Fix it for me: show me what changes first, and check afterwards that it’s gone.`;

export function alertActions(a: AlertLike): AlertAction[] {
  const fixes = (Array.isArray(a.fix) ? a.fix : a.fix ? [a.fix] : []).filter((f) => !!f?.tool);
  const out: AlertAction[] = fixes.map((fix) => ({ kind: 'fix', fix }));
  if (a.open) out.push({ kind: 'open', ...a.open });
  out.push({ kind: 'check', label: 'Check again' });
  // a fix that only looks (finding the old route) isn't a fix: Unit7 is offered too
  if (!fixes.some((f) => !f.look)) out.push({ kind: 'ask', label: 'Ask Unit7 to fix it', prompt: a.ask ?? askFallback(a.text) });
  return out;
}

// what "Check again" sends for a Home task, from its id: a map or site check ("site:down:shop.example.com"), a server's
// risk ("risk:<finding id>", the server in about), the server watch ("watch:<server>:<key>"); nothing for the rest
export function taskCheck(t: { id: string; about?: { kind: string; id: string } }): { key: string; serverId?: string; about?: string } | undefined {
  const server = t.about?.kind === 'server' ? t.about.id : undefined;
  if (t.id.startsWith('site:')) return { key: t.id.slice(5), ...(t.about && t.about.kind !== 'server' && { about: t.about.id }) };
  if (t.id.startsWith('risk:')) { const key = t.id.slice(5); const srv = /\bsrv_[\w-]+/.exec(key)?.[0] ?? server; return { key, ...(srv && { serverId: srv }) }; }
  const w = /^watch:(srv_[\w-]+):(.+)$/.exec(t.id);
  if (w) return { key: w[2]!, serverId: w[1]! };
  return undefined;
}

// what a fix's verified result says, in a line
export type Verified = { fixed: boolean; still?: string; cleared?: string[] };
export const verifiedOf = (out: unknown): Verified | undefined => {
  const v = (out as { verified?: Verified } | undefined)?.verified;
  return v && typeof v === 'object' && typeof v.fixed === 'boolean' ? v : undefined;
};
