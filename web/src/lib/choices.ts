// Every decision as real buttons: two to four choices, exactly one recommended (with a short why), built from what
// Unit7 already knows: a failed step's error (nextstep.ts), a finding's fix with its other ways and by-hand steps, a
// Map alert's actions (alertActions.ts), a failed deploy, an approval. Nothing here invents an action: each choice is
// a tool Unit7 already has (run as the person, through the gate), a page, a sentence for Unit7's AI, or something to
// set up first ("Set it up"). Pure, so tests and every page share it; pages/choices draws the row.
import { nextStep } from './nextstep.ts';
import { alertActions, askFallback, type AlertAction, type AlertLike } from './alertActions.ts';
import { PROVIDER_NAMES } from './words.ts';

export type Risk = 'safe' | 'change' | 'danger';
// what isn't set up yet: an account for a provider, phone alerts, a server, a domain, an AI to answer, Coolify on a
// server, an app on a server
export type SetupKind = 'account' | 'phone' | 'server' | 'domain' | 'brain' | 'coolify' | 'serverapp';
export interface Setup { kind: SetupKind; provider?: string; serverId?: string }
export interface Choice {
  label: string;
  why?: string;                 // a reason, read as "Recommended: <label> because <why>."
  recommended?: boolean;
  tool?: string; input?: Record<string, unknown>; // runs through the gate as the person
  ask?: string;                 // a sentence for Unit7's AI (the person's request, or their reply in the chat)
  href?: string;                // a page in Unit7, or a link
  setup?: Setup;                // not set up yet: opens that setup (inline in the chat)
  steps?: string[];             // do it by hand: the steps, shown under the row
  flow?: { kind: 'coolify-domain'; serverId: string }; // a guided pop-up does it in steps
  risk?: Risk;                  // danger: held to confirm
  peopleOnly?: boolean;         // a person's call: an AI never takes it
  typeName?: string;            // hard to undo: the person types this name first
  change?: string;              // what it changes, in a line
  look?: boolean;               // only looks, changes nothing
  key?: string;                 // the caller's own id for it (Approve, an ask's option, an alert's action)
}
export const MAX_CHOICES = 4;
type Maybe = Choice | false | null | undefined | '';

// At most four, no label twice, exactly one recommended: the first marked one (kept even when it came fifth), else
// the first.
export function pick(list: Maybe[]): Choice[] {
  const all: Choice[] = [];
  for (const c of list) if (c && c.label?.trim() && !all.some((o) => o.label.toLowerCase() === c.label.toLowerCase())) all.push(c);
  const kept = all.slice(0, MAX_CHOICES);
  const rec = all.find((c) => c.recommended);
  if (rec && !kept.includes(rec)) kept[kept.length - 1] = rec;
  const at = Math.max(0, kept.findIndex((c) => c.recommended));
  return kept.map((c, i) => ({ ...c, recommended: i === at }));
}
export const recommendedOf = (list: Choice[]) => list.find((c) => c.recommended);
// "Recommended: Set it up because this needs a Vercel account and none is connected yet."
export const recommendLine = (c?: Choice) => (c?.why ? `Recommended: ${c.label} because ${c.why.replace(/[.\s]+$/, '')}.` : undefined);

// --- not set up yet ----------------------------------------------------------------------------------------------
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const NAMES = Object.entries(PROVIDER_NAMES);
// a provider's id from the name an error uses ("vercel", "Google Cloud", "GitHub")
function providerId(name: string): string {
  const n = name.trim().toLowerCase();
  return NAMES.find(([id, label]) => id === n || label.toLowerCase() === n)?.[0] ?? n.replace(/[^a-z0-9]/g, '');
}
// "No vercel account is connected", "staging has no vercel account", "Connect your Hostinger account first",
// "Connect the cloudflare account that holds…", "Connect Cloudflare first", "Connect GitHub so…", "…’s DNS is at GoDaddy"
const NAMED = /\b(?:no|has no|connect(?: your| the)?)\s+([a-z][\w.]*(?: [a-z][\w.]*)?)\s+account\b/i;
const CONNECT = /\bConnect (?:your |the )?([A-Z][\w.]*)/;
const AT = /\bis at ([A-Z][\w.]*)/;
const providerOf = (m: string) => [NAMED, CONNECT, AT].map((re) => re.exec(m)?.[1]).map((x) => x && providerId(x)).find((p) => p && !['that', 'one', 'it', 'the'].includes(p)) || undefined;

// Which setup an error is waiting on, from its code (the words only say which provider)
export function setupOf(err: { code?: string; message?: string }, input?: unknown): Setup | undefined {
  const code = err.code ?? '', m = err.message ?? '';
  const serverId = obj(input) && typeof input.serverId === 'string' ? input.serverId : undefined;
  const at = serverId ? { serverId } : {};
  if (code === 'no_account') { if (/phone alerts/i.test(m)) return { kind: 'phone' }; const provider = providerOf(m); return { kind: 'account', ...(provider && { provider }) }; }
  if (code === 'not_connected') return { kind: 'serverapp', ...at };
  if (code === 'coolify_not_connected') return { kind: 'coolify', ...at };
  if (code === 'no_server' && /no prepared server|connect one/i.test(m)) return { kind: 'server' };
  if (code === 'no_domain') return { kind: 'domain' };
  if (code === 'no_brain') return { kind: 'brain' };
  return undefined;
}
const nameOf = (p?: string) => (p ? PROVIDER_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1) : undefined);
// what it needs, in words: "a Vercel account", "phone alerts", "a server"…
export function setupWhat(s: Setup): string {
  switch (s.kind) {
    case 'account': return s.provider ? `a ${nameOf(s.provider)} account` : 'an account';
    case 'phone': return 'phone alerts';
    case 'server': return 'a server';
    case 'domain': return 'a domain';
    case 'brain': return 'an AI to answer';
    case 'coolify': return 'Coolify connected';
    case 'serverapp': return 'that app on the server connected';
  }
}
// the title of the setup step in the chat: "Connect Vercel", "Set up phone alerts"…
export function setupTitle(s: Setup): string {
  switch (s.kind) {
    case 'account': return s.provider ? `Connect ${nameOf(s.provider)}` : 'Connect an account';
    case 'phone': return 'Set up phone alerts';
    case 'server': return 'Connect a server';
    case 'domain': return 'Set up a domain';
    case 'brain': return 'Pick who answers';
    case 'coolify': return 'Connect Coolify';
    case 'serverapp': return 'Connect the app on the server';
  }
}
// where it's set up outside the chat (a domain opens its own pop-up instead)
export function setupHref(s: Setup): string | undefined {
  switch (s.kind) {
    case 'account': return s.provider ? `/connections?connect=${encodeURIComponent(s.provider)}` : '/connections';
    case 'phone': return '/connections?connect=ntfy';
    case 'server': return '/servers?new=1';
    case 'domain': return undefined;
    case 'brain': return '/';
    case 'coolify': return s.serverId ? `/servers/${s.serverId}#coolify-connect` : '/connections';
    case 'serverapp': return s.serverId ? `/servers/${s.serverId}/apps` : '/servers';
  }
}
// what "Continue" says for the person once it's set up, so the AI carries on with the task it was doing
// (no AI picked yet: the request itself goes again)
export function continueText(s: Setup, request?: string): string {
  if (s.kind === 'brain') return request?.trim() || 'Carry on where you left off.';
  const done: Record<Exclude<SetupKind, 'brain'>, string> = {
    account: s.provider ? `I’ve connected ${nameOf(s.provider)}.` : 'I’ve connected the account.', phone: 'Phone alerts are set up.', server: 'I’ve connected a server.',
    domain: 'My domain is set up.', coolify: 'Coolify is connected.', serverapp: 'I’ve connected the app on the server.',
  };
  return `${done[s.kind]} Carry on where you left off.`;
}

// --- after something didn't work ---------------------------------------------------------------------------------
type Result = { status: string; error?: { code: string; message: string }; why?: string };
export interface ErrorCtx { tool?: string; input?: unknown; ask?: string }
// Unit7's own answers (a wrong value, not allowed, not there): trying again changes nothing
const NO_RETRY = new Set(['invalid_input', 'forbidden', 'not_found', 'confirm_name', 'confirm_needed', 'already', 'exists', 'needs_person', 'not_here', 'unsupported', 'domain_taken', 'account_paused']);
// …and nothing to offer at all
const QUIET = new Set(['invalid_input', 'forbidden', 'not_found', 'confirm_name', 'confirm_needed', 'not_here', 'needs_person', 'already', 'exists']);

export function errorChoices(r: Result, o: ErrorCtx = {}): Choice[] {
  if (r.status === 'approval_required') return pick([{ label: 'Open approvals', href: '/approvals', recommended: true, why: 'it runs as soon as someone says OK' }]);
  if (r.status !== 'error' || !r.error) return [];
  const { code = '', message = '' } = r.error;
  const input = obj(o.input) ? o.input : undefined;
  const step = nextStep(r as Parameters<typeof nextStep>[0], input);
  const setup = setupOf(r.error, input);
  const retry: Maybe = !!o.tool && !NO_RETRY.has(code) && { label: 'Try again', tool: o.tool, input: input ?? {}, why: 'it looks like a short hiccup, and nothing was changed' };
  const ask: Choice = { label: 'Ask Unit7 why', ask: o.ask ?? `This didn’t work: “${message.slice(0, 240)}”. Why, and how do I fix it?`, why: 'Unit7’s AI can read what happened and tell you the fix' };
  if (setup) return pick([{ label: 'Set it up', setup, href: setupHref(setup), recommended: true, why: `this needs ${setupWhat(setup)}, and it isn’t set up yet` },
    retry && { ...retry, why: 'once it’s set up, it can go through' }, ask]);
  if (!step) return QUIET.has(code) ? [] : pick([{ ...ask, recommended: true }, retry]);
  switch (step.kind) {
    // (without a page to open, Unit7's AI is the way forward)
    case 'coolify_permission': return pick([!!step.href && { label: step.label, href: step.href, recommended: true, why: 'Coolify’s key can’t read the values yet' }, ask]);
    case 'reconnect': return pick([!!step.href && { label: step.label, href: step.href, recommended: true, why: 'the sign-in was refused, so it needs a fresh one' }, retry && { ...retry, why: 'after reconnecting' }, ask]);
    case 'server': return pick([!!step.href && { label: step.label, href: step.href, recommended: true, why: 'the server needs a look from you first' }, ask]);
    case 'retry': return pick([retry && { ...retry, recommended: true }, ask]);
    case 'approvals': return pick([{ label: step.label, href: step.href, recommended: true, why: 'it runs as soon as someone says OK' }]);
    default: return pick([{ ...ask, recommended: true }, retry && { ...retry, why: 'if it was a one-off' }]);
  }
}

// a failed step in the chat thread (role 'tool'), with the code the server kept: what isn't set up comes first, a
// deploy gets the deploy's own choices
// href: the app's page, when the caller knows it (a deploy's "See the log")
export function stepChoices(s: { tool: string; input?: unknown; status: string; error?: string; code?: string }, href?: string): Choice[] {
  if (s.status !== 'error') return [];
  const r = { status: 'error', error: { code: s.code ?? '', message: s.error ?? '' } };
  const serviceId = obj(s.input) && typeof s.input.serviceId === 'string' ? s.input.serviceId : undefined;
  if (s.tool === 'deployment.create' && !setupOf(r.error, s.input)) return deployChoices({ serviceId, error: s.error, href });
  return errorChoices(r, { tool: s.tool, input: s.input });
}

// --- a finding's fix: the fix, its other ways, check again, by hand ----------------------------------------------
type Act = { tool: string; input: Record<string, unknown>; label: string };
type ToolFixLike = Act & { change?: string; safe?: boolean; undo?: Act; typeName?: string; byHand?: string[]; alt?: (Act & { change?: string; safe?: boolean })[] };
type ManualFixLike = { manual: string[]; label?: string; href?: string; ask?: string; flow?: { kind: 'coolify-domain'; serverId: string } };
export interface FindingLike { id: string; title: string; severity: string; detail?: string; by?: string; serverId?: string; about?: { kind: string; id?: string; name: string }; fix?: ToolFixLike | ManualFixLike | null }

const riskOf = (f: { safe?: boolean; typeName?: string }): Risk => (f.typeName ? 'danger' : f.safe ? 'safe' : 'change');
export function findingChoices(f: FindingLike): Choice[] {
  const fix = f.fix;
  const serverId = f.serverId ?? (f.about?.kind === 'server' ? f.about.id : undefined);
  const check: Maybe = f.by !== 'ai' && { label: 'Check again', tool: 'alert.recheck', input: { key: f.id, ...(serverId && { serverId }) }, look: true, key: 'check', why: 'it runs the check behind this again, read-only' };
  if (fix && 'tool' in fix) return pick([
    { label: fix.label, tool: fix.tool, input: fix.input, change: fix.change, typeName: fix.typeName, risk: riskOf(fix), recommended: true,
      why: fix.typeName ? 'it fixes the cause; it’s hard to undo, so you type the name first' : fix.safe ? 'it’s safe and can be undone' : fix.undo ? 'it fixes the cause and can be undone' : 'it fixes the cause' },
    ...(fix.alt ?? []).map((a): Choice => ({ label: a.label, tool: a.tool, input: a.input, change: a.change, risk: riskOf(a) })),
    check,
    !!fix.byHand?.length && { label: 'Do it by hand', steps: fix.byHand, peopleOnly: true },
  ]);
  if (fix?.flow) return pick([{ label: fix.label ?? 'Show me', flow: fix.flow, recommended: true, why: 'a short guided pop-up does it step by step' }, check, !!fix.manual.length && { label: 'Do it by hand', steps: fix.manual, peopleOnly: true }]);
  if (fix?.ask) return pick([{ label: fix.label ?? 'Ask Unit7', ask: fix.ask, recommended: true, why: 'Unit7’s AI looks into it first, and nothing changes without you' },
    check, !!fix.manual.length && { label: 'Do it by hand', steps: fix.manual, peopleOnly: true }, fix.href && { label: 'Take me there', href: fix.href }]);
  if (fix) return pick([{ label: fix.label && fix.label !== 'Show me how' ? fix.label : 'Show me how', steps: fix.manual, peopleOnly: true, recommended: true, why: 'only a person can do this one, in a few steps' },
    fix.href && { label: 'Take me there', href: fix.href }, check]);
  return pick([{ label: 'Ask Unit7 to fix it', ask: askFallback(`${f.title}. ${f.detail ?? ''}`), recommended: true, why: 'there’s no one-click fix, so Unit7’s AI shows you what it would change first' }, check]);
}

// --- a Map alert (alerts/Resolve.tsx): its fixes, a page, Check again, Ask Unit7 ------------------------------------
// key: the action's place in the list, so the row's caller runs it its own way ("fix:0", "open", "check", "ask")
export function alertChoices(actions: AlertAction[]): Choice[] {
  const first = actions.findIndex((a) => a.kind === 'fix' || a.kind === 'open');
  const recAt = first > -1 ? first : Math.max(0, actions.findIndex((a) => a.kind === 'ask'));
  return pick(actions.map((a, n): Choice => {
    const recommended = n === recAt;
    if (a.kind === 'fix') return { key: `fix:${n}`, label: a.fix.label, tool: a.fix.tool, input: a.fix.input, change: a.fix.change, typeName: a.fix.typeName, look: a.fix.look, risk: a.fix.typeName ? 'danger' : a.fix.look ? 'safe' : 'change', recommended,
      why: a.fix.look ? 'it only looks, so nothing changes yet' : a.fix.typeName ? 'it fixes the problem; it’s hard to undo, so you type the name first' : 'it fixes the problem, and Unit7 checks afterwards that it’s gone' };
    if (a.kind === 'open') return { key: 'open', label: a.label, href: a.href, recommended, why: 'that’s where it gets fixed' };
    if (a.kind === 'check') return { key: 'check', label: a.label, look: true, recommended, why: 'it runs the check behind this again, read-only' };
    return { key: 'ask', label: a.label, ask: a.prompt, recommended, why: 'there’s no one-click fix, so Unit7’s AI shows you what it would change first' };
  }));
}

// --- a deploy that didn't go live ----------------------------------------------------------------------------------
export function deployChoices(d: { serviceId?: string; error?: string | null; step?: string; service?: string; number?: number; href?: string }): Choice[] {
  const what = `${d.step ? `The ${d.step} step of ` : 'The '}deploy${d.number ? ` v${d.number}` : ''}${d.service ? ` of ${d.service}` : ''}`;
  return pick([
    { label: 'Ask Unit7 to fix it', ask: `${what} failed: ${(d.error ?? '').slice(0, 300)}. Read its log, tell me why in plain words, and fix it.`, recommended: true,
      why: 'it reads the log, finds the cause and fixes it; your site kept the old version' },
    !!d.serviceId && { label: 'Deploy again', tool: 'deployment.create', input: { serviceId: d.serviceId }, risk: 'change', change: 'Builds and deploys it again; the old version keeps serving until the new one is healthy' },
    !!d.serviceId && d.step === 'test' && { label: 'Deploy anyway', tool: 'deployment.create', input: { serviceId: d.serviceId, skipTests: true }, risk: 'danger', peopleOnly: true, change: 'Deploys without running the tests' },
    !!d.href && { label: 'See the log', href: `${d.href}#logs`, look: true },
  ]);
}

// --- an approval: Approve when Unit7 thinks it's safe, else Review first -------------------------------------------
// hard: the policy's own words for a change that's hard to take back (tier 3), or its tier
export const hardApproval = (a: { tier?: number; hard?: boolean; why?: string }) => !!a.hard || (a.tier ?? 0) >= 3 || /hard to undo|can.t be taken back|fresh backup/i.test(a.why ?? '');
export function approvalChoices(a: { tier?: number; hard?: boolean; why?: string; review?: string }): Choice[] {
  const reject: Choice = { key: 'reject', label: 'Not now', why: 'nothing changes' };
  return hardApproval(a)
    ? pick([{ key: 'review', label: 'Review it first', href: a.review ?? '/approvals', recommended: true, why: 'it’s hard to undo, so look at exactly what changes before saying yes' },
      { key: 'approve', label: 'Approve', risk: 'danger', peopleOnly: true }, reject])
    : pick([{ key: 'approve', label: 'Approve', peopleOnly: true, recommended: true, why: 'Unit7 thinks it’s safe: it keeps an undo and checks it afterwards' }, reject]);
}

// --- one door for all of them ------------------------------------------------------------------------------------
// an error result (from runTool), a finding, or a Map alert
export function choicesFor(x: Result | FindingLike | AlertLike, o: ErrorCtx = {}): Choice[] {
  if ('status' in x) return errorChoices(x, o);
  if ('severity' in x && 'title' in x) return findingChoices(x);
  if ('text' in x) return alertChoices(alertActions(x));
  return [];
}
