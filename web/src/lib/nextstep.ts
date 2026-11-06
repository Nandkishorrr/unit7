// What to do after something didn't work. An error that only says "it failed" is a dead end: each one Unit7 knows
// gets the one obvious next step (Connect, Reconnect, Try again, Open approvals, Give permission, Ask Unit7 why).
// Pure, so it's tested without a browser; ui.tsx turns a step into a toast's button.

// Settings a web framework bakes into the page it sends: every visitor's browser gets them anyway
// (the same list as the server's, in src/tools/coolify.ts)
export const isPublicKey = (key: string) => /^(NEXT_PUBLIC_|VITE_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_|REACT_APP_)/.test(key);

type Result = { status: string; error?: { code: string; message: string }; why?: string };

// Coolify answered but left the value out: its key can't read values (the two ways around it are offered)
export const revealProblem = (r: Result): 'no_value' | undefined => (r.status === 'error' && r.error?.code === 'coolify_permission' ? 'no_value' : undefined);

export type StepKind = 'retry' | 'connections' | 'reconnect' | 'connect_coolify' | 'coolify_permission' | 'approvals' | 'server' | 'ask';
export interface Step { kind: StepKind; label: string; href?: string }

const RETRY = new Set(['network', 'timeout', 'connection', 'unreachable', 'rate_limited', 'busy']);
// failures outside Unit7 (a provider, a command, a build): the AI can read what happened and say why
const ASK = /_error$|_failed$|^owned_by_paas$|^not_deployed$|^not_running$/;
const REFUSED = /\b401\b|unauthori[sz]ed|bad credentials|(token|key|credentials?)\b[^.]{0,24}\b(invalid|not valid|expired|revoked|refused)/i;

export function nextStep(r: Result, input?: unknown): Step | undefined {
  const serverId = input && typeof input === 'object' && typeof (input as { serverId?: unknown }).serverId === 'string' ? (input as { serverId: string }).serverId : undefined;
  const at = (s: Step, href?: string): Step => (href ? { ...s, href } : s);
  if (r.status === 'approval_required') return { kind: 'approvals', label: 'Open approvals', href: '/approvals' };
  if (r.status !== 'error' || !r.error) return undefined;
  const { code, message = '' } = r.error;
  if (code === 'coolify_not_connected') return at({ kind: 'connect_coolify', label: 'Connect Coolify' }, serverId && `/servers/${serverId}#coolify-connect`);
  if (code === 'coolify_permission') return at({ kind: 'coolify_permission', label: 'Give permission' }, serverId && `/servers/${serverId}#coolify-connect`);
  if (code === 'no_account' || code === 'not_connected') return at({ kind: 'connections', label: 'Connect' }, code === 'not_connected' && serverId ? `/servers/${serverId}/apps` : '/connections');
  if (code === 'account_paused' && /refused/.test(message)) return { kind: 'reconnect', label: 'Reconnect', href: '/connections' };
  if (code === 'host_key_changed' || code === 'needs_root') return serverId ? { kind: 'server', label: 'Open the server', href: `/servers/${serverId}` } : undefined;
  if (RETRY.has(code)) return { kind: 'retry', label: 'Try again' };
  if (REFUSED.test(message) && !['invalid_input', 'forbidden', 'not_found'].includes(code)) return { kind: 'reconnect', label: 'Reconnect', href: '/connections' };
  if (ASK.test(code)) return { kind: 'ask', label: 'Ask Unit7 why' };
  return undefined;
}
