// Run a one-click suggestion action (from Warden or the Get started checklist).
import { navigate } from './router';
import { act, confirmDialog, toast } from '../ui';
import { api, runTool } from './api';
import { connectAgent } from '../pages/AgentConnect';

export type SuggestionAction =
  | { label: string; kind: 'tool'; tool: string; input: Record<string, unknown>; success?: string; preview?: boolean }
  | { label: string; kind: 'navigate'; href: string }
  | { label: string; kind: 'connect'; agent: string }
  | { label: string; kind: 'ask'; prompt: string };

export interface Suggestion { id: string; severity: 'info' | 'warn' | 'alert'; text: string; actions: SuggestionAction[]; explain?: { what: string; why: string; next: string; advanced?: string } }

export async function runAction(a: SuggestionAction): Promise<boolean> {
  if (a.kind === 'navigate') {
    if (/^https?:\/\//.test(a.href)) window.open(a.href, '_blank', 'noopener');
    else navigate(a.href);
    return true;
  }
  if (a.kind === 'connect') return !!(await connectAgent(a.agent));
  // a code change: your own AI does it, so hand it a ready prompt
  if (a.kind === 'ask') {
    try { await navigator.clipboard.writeText(a.prompt); toast('ok', 'Copied. Paste it into Claude Code', 'Or into whichever AI you connected.'); }
    catch { toast('info', 'Paste this into your AI', a.prompt); }
    return true;
  }
  if (a.preview && !(await previewed(a))) return false;
  return !!(await act(a.tool, a.input, { success: a.success ?? 'Done' }));
}

// Show what a tool would do (its dry run) and ask before doing it. Copying settings lists the keys, and says so plainly
// when one looks like a live key going into a test copy.
async function previewed(a: Extract<SuggestionAction, { kind: 'tool' }>): Promise<boolean> {
  const r = await runTool(a.tool, a.input, { dryRun: true }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
  if (r.status !== 'dry_run') { toast('bad', 'That didn’t work', r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : undefined); return false; }
  const plan = r.plan as { from?: string; to?: string; keys?: { key: string; secret: boolean; live: boolean }[] } | undefined;
  if (!plan?.keys) return confirmDialog({ title: `${a.label}?`, confirm: a.label });
  if (!plan.keys.length) { toast('info', 'Nothing to copy', `${plan.to} already has these settings.`); return false; }
  const live = plan.keys.filter((k) => k.live).map((k) => k.key);
  return confirmDialog({
    title: `Copy ${plan.keys.length} setting${plan.keys.length > 1 ? 's' : ''} to ${plan.to}?`,
    body: `From ${plan.from}. The values stay on Unit7’s side; ${plan.to}’s apps get them on their next deploy. Undo removes them again.`,
    items: plan.keys.map((k) => `${k.key}${k.live ? '  · looks like a live key' : k.secret ? '  · secret' : ''}`),
    warning: live.length ? `${live.join(', ')} ${live.length > 1 ? 'look' : 'looks'} like a live key. In ${plan.to}, a test key is usually safer, so test payments don’t use real money.` : undefined,
    confirm: live.length ? 'Copy anyway' : 'Copy them',
  });
}

// One-click sign-in in a new tab: the tab is opened inside the click (so popup blockers allow it),
// then sent to the provider. It keeps no handle on Unit7's tab. When the provider sends you back,
// that tab says "connected" and closes; this tab updates live. If popups are blocked, same tab.
export async function openSignIn(providerId: string, name: string) {
  try { localStorage.setItem('unit7.connecting', String(Date.now())); } catch { /* the result just won't toast */ }
  const w = window.open('about:blank', '_blank');
  if (w) { w.document.title = `Connecting ${name}…`; w.document.body.style.cssText = 'font:15px system-ui;background:#0b0d12;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0'; w.document.body.textContent = `Opening ${name}…`; }
  try {
    const { url } = await api<{ url: string }>(`/api/connect/${providerId}/start`);
    if (w) { w.opener = null; w.location.href = url; } else window.location.href = url;
  } catch (e) {
    w?.close();
    toast('bad', `Couldn’t open ${name}`, (e as Error).message);
  }
}
