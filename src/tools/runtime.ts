// The one gate. The web UI, the CLI, MCP clients and Unit7's own agent all call execute(), so
// every action gets the same treatment:
//   validate input → tenant check on every id → find its environment → policy (role + autonomy +
//   rules) → approval if needed → run with timeout/retry, secrets resolved only inside → redact →
//   audit → event.
import { createHash } from 'node:crypto';
import { commandLog } from '../connectors/ssh.ts';
import { z } from 'zod';
import type { App } from '../app.ts';
import { type DB, all, get, id, json, now, run } from '../db.ts';
import { Unit7Error, notFound, forbidden } from '../errors.ts';
import { type Risk, type Role, type Rule, type EnvKind, decide, isAdmin } from '../policy.ts';
import { type Assessment, TIER_NAMES, decideTiered, tierOf } from '../policy.ts';
import { Redactor, looksRandom, looksSecretName } from '../redact.ts';
import { isRef, parseRef, slugify } from '../vault.ts';
import type { Severity } from '../events.ts';
import { importantTouched } from '../kept.ts';

// checks a person added, in their own words (care/rules.ts registers them, so this file needs nothing of theirs)
const lastChain = new Map<string, string>();
// which deletes wait (ops/index.ts): an AI's goes through a person at any autonomy, then the wait starts
let holds: { isHeld(tool: string, input: Record<string, unknown>, actor: Actor): boolean; hold(app: App, orgId: string, a: { id: string; tool: string; actor: Actor; by: string }): string } | undefined;
export const setHolds = (h: typeof holds) => { holds = h; };
export const gateRules: ((db: DB, orgId: string, input: Record<string, unknown>) => string | undefined)[] = [];

export interface Actor {
  kind: 'user' | 'agent' | 'token' | 'system';
  id: string | null;
  userId: string | null;
  name: string;
  role: Role;
  only?: readonly string[]; // a scoped key: these tools and nothing else, checked before anything else runs
  agent?: string; // which agent acted: "Unit7 agent", "Claude Code (MCP)"
}

export interface EnvRow { id: string; org_id: string; project_id: string; name: string; slug: string; kind: EnvKind; autonomy: number; rules: string }
export interface AccountRow { id: string; org_id: string; provider: string; name: string; slug: string; meta: string; status: string; pause_until?: string | null }

// --- provider accounts that refused Unit7, or asked it to slow down -------------------------------
// A token a provider refused never starts working by itself, and retrying it only gets the token or the
// account flagged; a 429 means wait. So background work (Warden, AI agents, scripts) stops for a refused
// account until a person reconnects it or checks it again, and waits after a rate limit. A person
// clicking in Unit7 is never blocked: each click is one deliberate try, and it's how an account gets fixed.
export function providerTrouble(e: unknown): 'auth' | 'rate' | undefined {
  if (!(e instanceof Error)) return undefined;
  const { code = '', status = 0, detail } = e as Partial<Unit7Error>;
  if ((detail as { nested?: boolean } | undefined)?.nested) return undefined; // a step's own run already noted it, on the account it used
  if (['forbidden', 'approval_required', 'no_account', 'account_paused', 'invalid_input', 'not_found'].includes(code)) return undefined; // Unit7's own answers
  if (status === 429 || /\b429\b|too many requests|rate.?limit/i.test(e.message)) return 'rate';
  if (status === 401 || code === 'mcp_unauthorized' || /invalid_grant|\b401\b|unauthori[sz]ed|bad credentials|authentication failed|(token|key|credentials?)\b[^.]{0,24}\b(invalid|not valid|expired|revoked)/i.test(e.message)) return 'auth';
}
export function noteAccountTrouble(app: App, accountId: string, e: unknown) {
  const t = providerTrouble(e);
  if (t === 'rate') run(app.db, 'UPDATE accounts SET pause_until = ? WHERE id = ?', new Date(Date.now() + 5 * 60_000).toISOString(), accountId);
  if (t === 'auth') {
    const a = get<{ org_id: string; name: string; status: string }>(app.db, 'SELECT org_id, name, status FROM accounts WHERE id = ?', accountId);
    if (!a || a.status === 'failing') return;
    run(app.db, `UPDATE accounts SET status = 'failing' WHERE id = ?`, accountId);
    app.events.emit(a.org_id, 'account.refused', `${a.name} refused Unit7’s credential. Unit7 stopped using it in the background; reconnect it or check it again in Connections.`, { severity: 'warning', resource: accountId });
  }
}
// May work in an environment use this account? Yes when a person bound it there, or when the environment has
// no account of that provider bound and this is the organisation's only one (the person connected it, and
// nothing says otherwise). A second account is never reached by default.
export function accountAllowed(db: DB, orgId: string, envId: string, account: { id: string; provider: string }) {
  if (get(db, 'SELECT 1 FROM environment_accounts WHERE environment_id = ? AND account_id = ?', envId, account.id)) return true;
  if (get(db, 'SELECT 1 FROM environment_accounts WHERE environment_id = ? AND provider = ?', envId, account.provider)) return false;
  return get<{ n: number }>(db, 'SELECT count(*) n FROM accounts WHERE org_id = ? AND provider = ?', orgId, account.provider)!.n === 1;
}

function accountPaused(account: AccountRow): Unit7Error | undefined {
  if (account.status === 'failing') return new Unit7Error('account_paused', `${account.name} refused Unit7’s credential, so Unit7 isn’t using it until a person reconnects it or checks it again in Connections.`, 409, { retryable: false });
  if (account.pause_until && account.pause_until > new Date().toISOString()) return new Unit7Error('account_paused', `${account.name} asked Unit7 to slow down. Unit7 waits until ${account.pause_until.slice(11, 16)} UTC before using it again in the background.`, 429, { retryable: false });
}

export interface Ctx {
  app: App;
  db: DB;
  orgId: string;
  actor: Actor;
  env: EnvRow | undefined;
  projectId: string | undefined;
  signal: AbortSignal;
  redactor: Redactor;
  resources: string[];
  // The credential broker. Resolves a reference for this execution only, refuses to cross the
  // environment's account boundary, and teaches the redactor the value.
  secret(ref: string): string;
  // The credential of the account this environment uses at `provider` (or the given account).
  credentialFor(provider: string, accountId?: string): { ref: string; value: string; account: AccountRow };
  progress(message: string): void;
  emit(type: string, message: string, o?: { severity?: Severity; resource?: string; data?: Record<string, unknown> }): void;
  conversationId?: string; // the Home chat a brain is answering, when it is one (ui.* tools ask the person there)
  // set while an action a person approved runs (or a step of one, ExecOptions.underApproval): checks inside a tool that
  // need "a person said yes" (an AI copying a live key, placing an app's key) read it. Only code sets it, never input.
  approvalId?: string;
}

export interface Tool<I = any, O = any> {
  name: string;          // "deployment.create"
  title: string;         // "Deploy a service"
  description: string;   // written for the model: when to use it, what it returns
  input: z.ZodType<I>;
  risk: Risk | ((input: I) => Risk);
  action: string | ((input: I) => string); // the policy key, e.g. "deploy", "database_write"
  timeoutMs?: number;
  retries?: number;      // only honoured for idempotent tools
  idempotent?: boolean;
  sensitive?: string[];  // fields never written to audit, in the input and in what it returns
  view?: (field: string, input: I, actor: Actor) => string | undefined; // what an approver sees of a sensitive field, when the plain mask would hide what they're deciding on
  peopleOnly?: boolean | ((input: I) => boolean | string); // an AI is denied outright, never queued for an approval it couldn't use (a string says why)
  dryRun?: (ctx: Ctx, input: I) => unknown | Promise<unknown>;
  // A machine's run that changed nothing (Warden's hourly "connect what belongs together" with nothing to connect) isn't an
  // action: no audit row, no event, and it never shows as work done. A person's run always counts.
  idle?: (output: O) => boolean;
  // Only creates or copies: nothing that exists changes, so it runs by itself from Recommend up (policy.ts). A promise made
  // here, tool by tool: a backup is green, a restore over live data never is.
  green?: boolean | ((input: I) => boolean);
  // What the gate needs beyond the input, from Unit7's own records (never from what a server prints): the risk tier,
  // whether the target is only discovered, how often an AI just did this, and the literal command an approval shows.
  assess?: (ctx: Pick<Ctx, 'app' | 'db' | 'orgId' | 'actor' | 'conversationId'> & { dryRun?: boolean }, input: I) => Assessment | undefined;
  run: (ctx: Ctx, input: I) => O | Promise<O>;
}

export type ToolResult =
  | { status: 'ok'; output: unknown; auditId: string; durationMs: number }
  | { status: 'dry_run'; plan: unknown; auditId: string }
  | { status: 'approval_required'; approvalId: string; why: string }
  | { status: 'denied'; why: string; auditId: string }
  | { status: 'error'; error: { code: string; message: string; logTail?: string }; auditId?: string }; // logTail: a log kept apart from the plain message

const registry = new Map<string, Tool>();
export function defineTool<I, O>(t: Tool<I, O>): Tool<I, O> {
  if (registry.has(t.name)) throw new Error(`tool ${t.name} defined twice`);
  registry.set(t.name, t as Tool);
  return t;
}
export const tools = () => [...registry.values()];
export const getTool = (name: string) => registry.get(name);

// --- tenant boundary ------------------------------------------------------------------------
// Every field named `*Id` must be a Unit7 id that belongs to this org. Ids are prefixed, so the
// prefix says which table to check. Foreign ids come back as "not found" — never "forbidden",
// which would confirm they exist.
const TABLE: Record<string, string> = {
  prj: 'projects', env: 'environments', acc: 'accounts', srv: 'servers', svc: 'services', dep: 'deployments',
  dom: 'domains', bak: 'backups', inc: 'incidents', apr: 'approvals', cnv: 'conversations', usr: 'memberships', upl: 'uploads',
  err: 'error_groups', task: 'agent_tasks', job: 'jobs', lnk: 'links',
  chg: 'changes',
  grp: 'product_groups', cli: 'clients',
  rtn: 'routines', ast: 'assets',
};
function checkOwnership(db: DB, orgId: string, input: unknown, path = ''): void {
  if (Array.isArray(input)) return input.forEach((v, i) => checkOwnership(db, orgId, v, `${path}[${i}]`));
  if (!input || typeof input !== 'object') return;
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && /Id$/.test(k)) {
      const table = TABLE[v.split('_')[0]!];
      if (!table) throw new Unit7Error('invalid_input', `${path}${k} is not a Unit7 id.`);
      const row = table === 'memberships'
        ? get(db, 'SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?', orgId, v)
        : get(db, `SELECT 1 FROM ${table} WHERE id = ? AND org_id = ?`, v, orgId);
      if (!row) throw notFound(`${k.replace(/Id$/, '')} ${v}`);
    } else if (typeof v === 'object') checkOwnership(db, orgId, v, `${path}${k}.`);
  }
}

// The environment an action lands in decides its policy. Most specific id wins.
function findEnv(db: DB, input: Record<string, unknown>): { env?: EnvRow; projectId?: string } {
  const pick = (sql: string, v: unknown) => (typeof v === 'string' ? get<{ e: string | null }>(db, sql, v)?.e ?? undefined : undefined);
  const envId =
    (typeof input.environmentId === 'string' ? input.environmentId : undefined) ??
    pick('SELECT environment_id e FROM services WHERE id = ?', input.serviceId) ??
    pick('SELECT s.environment_id e FROM deployments d JOIN services s ON s.id = d.service_id WHERE d.id = ?', input.deploymentId) ??
    pick('SELECT s.environment_id e FROM domains d JOIN services s ON s.id = d.service_id WHERE d.id = ?', input.domainId) ??
    pick('SELECT s.environment_id e FROM backups b JOIN services s ON s.id = b.service_id WHERE b.id = ?', input.backupId);
  const env = envId ? get<EnvRow>(db, 'SELECT * FROM environments WHERE id = ?', envId) : undefined;
  const projectId = env?.project_id ?? (typeof input.projectId === 'string' ? input.projectId : undefined);
  return { env, projectId };
}

// Every environment an action touches: any id anywhere in the input (a serviceId next to an environmentId,
// injectInto, lists) can land the change somewhere else, so each one's policy is checked, not just one.
const ENV_OF: Record<string, string> = {
  env: 'SELECT id e FROM environments WHERE id = ? AND org_id = ?',
  svc: 'SELECT environment_id e FROM services WHERE id = ? AND org_id = ?',
  dep: 'SELECT s.environment_id e FROM deployments d JOIN services s ON s.id = d.service_id WHERE d.id = ? AND d.org_id = ?',
  dom: 'SELECT s.environment_id e FROM domains d JOIN services s ON s.id = d.service_id WHERE d.id = ? AND d.org_id = ?',
  bak: 'SELECT s.environment_id e FROM backups b JOIN services s ON s.id = b.service_id WHERE b.id = ? AND b.org_id = ?',
};
function envsTouched(db: DB, orgId: string, input: unknown, found = new Map<string, EnvRow>()): Map<string, EnvRow> {
  if (typeof input === 'string') {
    const sql = /^[a-z]+_[\w-]+$/.test(input) ? ENV_OF[input.split('_')[0]!] : undefined;
    const e = sql && get<{ e: string | null }>(db, sql, input, orgId)?.e;
    if (e && !found.has(e)) { const row = get<EnvRow>(db, 'SELECT * FROM environments WHERE id = ?', e); if (row) found.set(e, row); }
  } else if (input && typeof input === 'object') for (const v of Object.values(input)) envsTouched(db, orgId, v, found);
  return found;
}
const STRICTNESS = { allow: 0, approve: 1, deny: 2 } as const;

// Threads where an AI may look around freely but every change waits for a person, and only one change may be proposed:
// a fix someone asked for by tapping "Let Unit7 fix it" on a phone alert. Read from the fix's own row (care/phonefix.ts),
// so it outlives a restart, until the fix ends, its AI says it's done, or its time (the inbox request's lifetime) is up.
// Strictly that conversation: the call says it, or it comes from the AI session (token) that claimed that conversation's
// inbox request. A call without a conversation is never the fix.
export const PHONE_FIX_OPEN = `status IN ('looking', 'proposed', 'fixing', 'declined')`;
function proposing(db: DB, orgId: string, conversationId: string | undefined, actor: Actor): { id: string; conversation_id: string; approval_id: string | null } | undefined {
  const conv = conversationId ?? (actor.kind !== 'user' && actor.id
    ? get<{ conversation_id: string }>(db, `SELECT conversation_id FROM agent_tasks WHERE org_id = ? AND claimed_token = ? AND status = 'claimed' ORDER BY claimed_at DESC LIMIT 1`, orgId, actor.id)?.conversation_id
    : undefined);
  if (!conv) return undefined;
  return get(db, `SELECT id, conversation_id, approval_id FROM care_fixes WHERE org_id = ? AND conversation_id = ? AND ${PHONE_FIX_OPEN} AND look_until > ? ORDER BY started_at DESC LIMIT 1`, orgId, conv, now());
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

// An approval waits up to a day with its input on disk, and people and AIs list approvals. A tool's sensitive
// fields (a value, a token) are kept sealed with the vault, shown as [sensitive], and opened only to run it.
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
function sealInput(app: App, orgId: string, approvalId: string, tool: Tool, input: Record<string, unknown>, actor: Actor) {
  const out = { ...input };
  for (const f of tool.sensitive ?? []) {
    const v = out[f];
    if (typeof v !== 'string' && (!v || typeof v !== 'object')) continue;
    const s = app.vault.sealValue(orgId, `approval:${approvalId}:${f}`, typeof v === 'string' ? v : JSON.stringify(v));
    // a list of settings seals whole, and an approver sees each one the way a .env line is shown
    const view = tool.view?.(f, input, actor) ?? (typeof v === 'string' ? viewOf(v, String(input.key ?? f)) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, viewOf(String(x), k)])));
    out[f] = { __sealed: `${b64(s.ciphertext)}.${b64(s.wrapped)}`, ...(typeof v !== 'string' && { json: true }), view };
  }
  return stable(out);
}
// What an approver is shown: enough to judge (a reference, a plain setting, the host a URL points at), never the
// secret part. A .env file is shown line by line the same way.
function viewOf(v: string, name: string): string {
  if (/\n/.test(v)) return v.split('\n').map((line) => { const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=(.*)$/.exec(line); return m ? `${m[1]}=${viewOf(m[2]!.trim(), m[1]!)}` : line.trim().startsWith('#') || !line.trim() ? line : '[line hidden]'; }).join('\n');
  if (isRef(v)) return v;
  const masked = new Redactor().redact(v);
  if (masked !== v) return masked; // known token shapes, passwords inside URLs
  return looksSecretName(name) || looksRandom(v) ? `[sensitive, ${v.length} characters]` : v;
}
const isSealed = (v: unknown): v is { __sealed: string; json?: boolean; view?: unknown } => !!v && typeof v === 'object' && typeof (v as { __sealed?: unknown }).__sealed === 'string';
export function openInput(app: App, orgId: string, approvalId: string, stored: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(json<Record<string, unknown>>(stored, {})).map(([k, v]) => {
    if (!isSealed(v)) return [k, v];
    const [c, w] = v.__sealed.split('.'), open = app.vault.openValue(orgId, `approval:${approvalId}:${k}`, Buffer.from(c!, 'base64'), Buffer.from(w!, 'base64'));
    return [k, v.json ? JSON.parse(open) : open];
  }));
}
export const viewInput = (stored: string) => Object.fromEntries(Object.entries(json<Record<string, unknown>>(stored, {})).map(([k, v]) => [k, isSealed(v) ? v.view ?? '[sensitive]' : v]));

// Tools whose job is to show a person a value wrap it as { __reveal: value }. Only a human caller
// gets it back; audit rows, events and agents get a placeholder. Everything else is redacted.
function shape(v: unknown, r: Redactor, reveal: boolean): unknown {
  if (v && typeof v === 'object' && '__reveal' in v) return reveal ? (v as { __reveal: unknown }).__reveal : '[shown only to the person who asked]';
  if (typeof v === 'string') return r.redact(v);
  if (Array.isArray(v)) return v.map((x) => shape(x, r, reveal));
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, r, reveal)]));
  return v;
}

const clip = (s: string, n = 20_000) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);

// After a change succeeds, the recheck (tools/recheck.ts) looks again at just what it touched and says whether the
// problem it was about is really gone: { fixed, still }. Added to the tool's output as `verified`, so the person and the
// AI get the truth from a check, not a guess. prepare runs before the change (what it touches, what was open: a removed
// thing can't be looked up afterwards) and hands back the look to take after it, or nothing when there's nothing to
// check. It never changes or fails the change itself. Set once at start-up.
export const afterChange: { prepare?: (ctx: Ctx, tool: string, input: Record<string, unknown>) => (() => Promise<unknown>) | undefined } = {};

export interface ExecOptions { dryRun?: boolean; reason?: string; approvalId?: string; signal?: AbortSignal; onProgress?: (m: string) => void; conversationId?: string;
  underApproval?: string; // a step of an action a person approved (its id): the step's own gate still decides; ctx.approvalId says the whole was approved
  onlyIfAllowed?: boolean; // Warden's own fixes: when a person would have to approve, nothing is asked or recorded (approval_required, no id)
  askFirst?: boolean | string; // waits for a person even where the gate would let it run (only ever stricter); a string says why
  question?: string; // what a person is asked, in plain words
}

// A key from an app on a server, an add-on or Coolify (their logins, admin passwords and full-access keys among them),
// named anywhere in a change an AI asks for: a person approves it first. env.ts checkRef refuses the people-only ones outright.
export const APP_KEY_REF = /credential:\/\/(serverapp|addon|coolify)\//;
// Unit7's own keys (backup encryption, phone approvals, SSH keys, backup storage) and its alert channels, whose messages carry
// approve buttons. They never go into an app, whoever asks.
// forge: keys saved before the rename. GitHub's hold an App's private key, or a person's own token
export const INTERNAL_REF = /^credential:\/\/(unit7|forge|ssh|storage|ntfy|webhook)\/|^credential:\/\/github\/[^/]+\/(token|user)$/;
// A key a person stored by hand: no account or database of Unit7's says where it belongs, so env.ts checkRef can't refuse it. Put
// into an app, that app's code can read it, and an AI may have written that code: a person says yes first.
function storedByHand(db: DB, orgId: string, ref: string) {
  if (!isRef(ref) || APP_KEY_REF.test(ref) || INTERNAL_REF.test(ref)) return false;
  const { provider, account } = parseRef(ref);
  return !get(db, 'SELECT 1 FROM accounts WHERE org_id = ? AND provider = ? AND slug = ?', orgId, provider, account)
    && !all<{ id: string }>(db, 'SELECT id FROM services WHERE org_id = ?', orgId).some((s) => slugify(s.id) === account);
}
// A key for people, not apps: a dashboard login or admin password, a full-access key (a service-role key, a root
// password), Coolify's own API token (it runs the whole server), or one Unit7 has no record of. An AI never places one.
export function peopleRef(app: App, orgId: string, ref: string) {
  if (!/^credential:\/\/(serverapp|addon|coolify)\//.test(ref)) return false;
  if (ref.startsWith('credential://coolify/')) return true;
  const row = app.vault.meta(orgId, ref);
  if (!row) return true;
  const m = json<{ people?: boolean; scope?: string; label?: string }>(row.meta, {});
  return !!m.people || /^full access/i.test(m.scope ?? '') || /admin|master|dashboard|root/i.test(m.label ?? '');
}

export async function execute(app: App, orgId: string, actor: Actor, name: string, rawInput: unknown, o: ExecOptions = {}): Promise<ToolResult> {
  const { db } = app;
  const found = registry.get(name);
  if (!found) return { status: 'error', error: { code: 'unknown_tool', message: `Unit7 has no tool called "${name}".` } };
  const tool = found;
  if (actor.only && !actor.only.includes(name)) return { status: 'denied', why: actor.only.includes('seven.finish') ? 'A shift of Seven’s is running here, so this can only look. Try again in a few minutes.' : 'This key can only read findings.', auditId: '' };

  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) return { status: 'error', error: { code: 'invalid_input', message: z.prettifyError(parsed.error) } };
  const input = parsed.data as Record<string, unknown>;

  try {
    checkOwnership(db, orgId, input);
  } catch (e) {
    const err = e as Unit7Error;
    return { status: 'error', error: { code: err.code, message: err.message } };
  }
  let assessed: Assessment | undefined;
  try { assessed = tool.assess?.({ app, db, orgId, actor, dryRun: !!o.dryRun, conversationId: o.conversationId }, input as never); }
  catch (e) { return { status: 'error', error: { code: (e as Unit7Error).code ?? 'internal', message: (e as Error).message } }; }

  const { env, projectId } = findEnv(db, input);
  const risk = typeof tool.risk === 'function' ? tool.risk(input) : tool.risk;
  const action = typeof tool.action === 'function' ? tool.action(input) : tool.action;
  // marked important by a person (asset.keep): an AI asks a person before changing it in production, at any autonomy. Healing
  // that comes back by itself (T1: a restart, a backup) stays automatic. Only ever stricter: decideTiered keeps the strictest.
  if ((actor.kind === 'agent' || actor.role === 'agent') && risk !== 'read' && !assessed?.ask) {
    const tier = assessed?.tier ?? tierOf(action, risk);
    const what = tier >= 2 ? importantTouched(db, orgId, input) : undefined;
    if (what) assessed = { ...assessed, tier, ask: `${what} is marked important, so an AI asks a person before changing it.` };
  }
  const redactor = new Redactor();
  const ran: string[] = []; // the commands this action sends to a server, for the expert view
  const auditInput = { ...input };
  for (const f of tool.sensitive ?? []) if (f in auditInput) auditInput[f] = '[sensitive]';

  // A person browsing the UI is not an action; machines reading, and every change, are.
  const quiet = risk === 'read' && action === 'read' && actor.kind === 'user';
  const audit = (result: string, extra: { output?: unknown; error?: string; durationMs?: number; resources?: string[]; approvalId?: string } = {}) => {
    if (quiet && (result === 'success' || result === 'dry_run')) return '';
    const auditId = id('aud'), inputText = clip(stable(redactor.redactDeep(auditInput)));
    // every change links to the one before it, so a line altered later shows up (ops/index.ts). Reads get trimmed, so they stay out.
    const prev = risk === 'read' ? null : lastChain.get(orgId) ?? get<{ chain: string }>(db, 'SELECT chain FROM audit WHERE org_id = ? AND chain IS NOT NULL ORDER BY rowid DESC LIMIT 1', orgId)?.chain ?? 'start';
    const chain = prev === null ? null : createHash('sha256').update(`${prev}\n${auditId}\n${actor.name}\n${name}\n${inputText ?? ''}\n${result}`).digest('hex');
    if (chain) lastChain.set(orgId, chain);
    run(db, `INSERT INTO audit (id, org_id, actor_kind, actor_id, actor_name, agent, user_id, project_id, environment_id, tool, action, risk,
      reason, input, output, result, error, duration_ms, resources, approval_id, chain, prev_chain, commands) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      auditId, orgId, actor.kind, actor.id, actor.name, actor.agent ?? null, actor.userId, projectId ?? null, env?.id ?? null, name, action, risk,
      o.reason ?? null, inputText,
      extra.output === undefined ? null : clip(JSON.stringify(redactor.redactDeep(extra.output)) ?? 'null'),
      result, extra.error ?? null, extra.durationMs ?? null, JSON.stringify(extra.resources ?? []), extra.approvalId ?? null, chain, prev, ran.length ? JSON.stringify(ran.map((c) => redactor.redact(c))) : null);
    return auditId;
  };

  // --- policy ---
  const org = get<{ autonomy: number; rules: string }>(db, 'SELECT autonomy, rules FROM orgs WHERE id = ?', orgId);
  const policyOf = (e: EnvRow | undefined) => e
    ? { kind: e.kind, autonomy: e.autonomy, rules: json<Record<string, Rule>>(e.rules, {}), name: e.name }
    : { kind: 'production' as const, autonomy: org?.autonomy ?? 3, rules: json<Record<string, Rule>>(org?.rules, {}), name: 'org-wide resources', orgWide: true };
  const touched = [env, ...[...envsTouched(db, orgId, input).values()].filter((e) => e.id !== env?.id)];
  const isAgent = actor.kind === 'agent' || actor.role === 'agent';
  // the strictest answer among them wins; on a tie, production's (so its approval needs an admin)
  const green = typeof tool.green === 'function' ? tool.green(input as never) : tool.green;
  const decideAll = (r: Risk, a?: Assessment) => touched.map((e) => ({ e, d: decideTiered({ actor: isAgent ? 'agent' : 'human', role: actor.role, risk: r, action, env: policyOf(e), green, ...a }) }))
    .reduce((a, b) => (STRICTNESS[b.d.decision] > STRICTNESS[a.d.decision] || (STRICTNESS[b.d.decision] === STRICTNESS[a.d.decision] && b.e?.kind === 'production' && a.e?.kind !== 'production') ? b : a));
  let approvalId: string | undefined;
  // people-only means a person in the web app (or on their phone): a token could be any program on the computer
  const peopleOnly = typeof tool.peopleOnly === 'function' ? tool.peopleOnly(input as never) : tool.peopleOnly;
  if (actor.kind !== 'user' && peopleOnly) {
    const why = typeof peopleOnly === 'string' ? peopleOnly : `Only a person can ${tool.title.toLowerCase()}. An AI can't do this, even with approval.`;
    return { status: 'denied', why, auditId: audit('denied', { error: why }) };
  }
  // a person's rule in plain words binds every AI and Warden (care/rules.ts). Green steps only create, so they pass.
  if (actor.kind !== 'user' && risk !== 'read' && !green) {
    const why = gateRules.map((check) => check(db, orgId, input)).find(Boolean);
    if (why) return { status: 'denied', why, auditId: audit('denied', { error: why }) };
  }
  if (o.dryRun) {
    // A dry run changes nothing, so it only needs read access.
    const { d } = decideAll('read');
    if (d.decision === 'deny') return { status: 'denied', why: d.why, auditId: audit('denied', { error: d.why }) };
  } else {
    // the Autopilot kill switch: a person paused it, so no AI changes anything until they resume it
    if (isAgent && risk !== 'read' && get<{ paused_at: string | null }>(db, 'SELECT paused_at FROM orgs WHERE id = ?', orgId)?.paused_at) {
      const why = 'Autopilot is paused, so Unit7 and AI agents can only look, not change anything. A person can still act, or resume Autopilot.';
      return { status: 'denied', why, auditId: audit('denied', { error: why }) };
    }
    const refs = isAgent && risk !== 'read' ? [...JSON.stringify(input).matchAll(/credential:\/\/[^"\s\\]+/g)].map((m) => m[0]) : [];
    const appKeys = refs.filter((r) => APP_KEY_REF.test(r));
    const people = appKeys.find((r) => peopleRef(app, orgId, r));
    if (people) { const why = `${people} is a login or full-access key meant for people. An AI can’t use it, even with approval; a person can.`; return { status: 'denied', why, auditId: audit('denied', { error: why }) }; }
    const placesAppKey = appKeys.length > 0;
    const handKeys = action === 'env_write' && !o.underApproval ? refs.filter((r) => storedByHand(db, orgId, r)) : [];
    const { d: plain, e: where } = decideAll(risk, placesAppKey ? { ...assessed, tier: Math.max(assessed?.tier ?? 0, 2) as Assessment['tier'], discovered: true }
      : handKeys.length ? { ...assessed, tier: Math.max(assessed?.tier ?? 0, 2) as Assessment['tier'], ask: `An app can read ${handKeys.join(', ')} once it has it, so a person says yes first.` } : assessed);
    // a fix someone asked for from a phone alert: the AI looks freely, then proposes one change, which waits for them
    const fix = !o.approvalId && isAgent && risk !== 'read' && plain.decision !== 'deny' ? proposing(db, orgId, o.conversationId, actor) : undefined;
    if (fix?.approval_id) { const why = 'One fix from the phone alert is already waiting for the person’s OK. Stop here and say in a line what it does.'; return { status: 'denied', why, auditId: audit('denied', { error: why }) }; }
    // a step of something a person approved was asked already
    const held = actor.kind !== 'user' && !o.approvalId && !o.underApproval && holds?.isHeld(name, input, actor);
    const decided = held && plain.decision === 'allow' ? { decision: 'approve' as const, why: 'An AI’s delete waits for a person at any autonomy, then 48 hours more.' }
      : o.askFirst && plain.decision === 'allow' ? { decision: 'approve' as const, why: typeof o.askFirst === 'string' ? o.askFirst : 'Seven asks before doing this.' } : fix && plain.decision === 'allow' ? { decision: 'approve' as const, why: 'You asked for this fix from your phone, so it waits for your OK.' } : plain;
    // an approval card shows the tier, what happens, and the literal command
    const d = assessed?.shows || assessed?.impact ? { ...decided, why: [decided.why, `${TIER_NAMES[assessed.tier]}.`, assessed.impact, assessed.shows && `Runs: ${assessed.shows}`].filter(Boolean).join(' ') } : decided;
    if (d.decision === 'deny') return { status: 'denied', why: d.why, auditId: audit('denied', { error: d.why }) };
    if (o.approvalId) {
      // single use: the status flip is the lock; the action must be exactly the one approved
      const row = get<{ input: string }>(db, `SELECT input FROM approvals WHERE id = ? AND org_id = ? AND status = 'approved' AND tool = ?`, o.approvalId, orgId, name);
      const same = !!row && stable(openInput(app, orgId, o.approvalId, row.input)) === stable(input);
      const used = same ? run(db, `UPDATE approvals SET status = 'executing' WHERE id = ? AND status = 'approved'`, o.approvalId) : { changes: 0 };
      if (!used.changes) return { status: 'error', error: { code: 'approval_invalid', message: 'That approval does not match this action, or it was already used.' } };
      approvalId = o.approvalId;
    } else if (d.decision === 'approve') {
      if (o.onlyIfAllowed) return { status: 'approval_required', approvalId: '', why: d.why };
      approvalId = id('apr');
      run(db, `INSERT INTO approvals (id, org_id, tool, input, reason, why, actor, environment_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        approvalId, orgId, name, sealInput(app, orgId, approvalId, tool, input, actor), o.reason ?? null, d.why, JSON.stringify(actor), where?.id ?? null,
        new Date(Date.now() + 24 * 3600_000).toISOString());
      audit('pending_approval', { approvalId });
      if (fix) run(db, 'UPDATE care_fixes SET approval_id = ? WHERE id = ?', approvalId, fix.id);
      app.events.emit(orgId, 'approval.requested', o.question ?? `${actor.name} wants to run ${tool.title.toLowerCase()}: ${d.why}`, {
        severity: 'warning', projectId, environmentId: env?.id, resource: approvalId, data: { tool: name, approvalId, reason: o.reason, ...(o.question && { question: true }), ...(fix && { conversationId: fix.conversation_id, phoneFix: true }) },
      });
      return { status: 'approval_required', approvalId, why: d.why };
    }
  }

  // --- run ---
  const ac = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, ac.signal]) : ac.signal;
  const resources: string[] = [];
  const used = new Set<string>(); // accounts whose credential this run used
  const ctx: Ctx = {
    // a scoped key stops at the door: a tool it may use can do its own work
    app, db, orgId, actor: actor.only ? { ...actor, only: undefined } : actor, env, projectId, signal, redactor, resources, conversationId: o.conversationId, approvalId: approvalId ?? o.underApproval,
    secret(ref) {
      const r = parseRef(ref);
      if (env) {
        const bound = get<{ slug: string }>(db,
          'SELECT a.slug FROM environment_accounts ea JOIN accounts a ON a.id = ea.account_id WHERE ea.environment_id = ? AND ea.provider = ?', env.id, r.provider);
        if (bound && bound.slug !== r.account) {
          throw forbidden(`${env.name} uses the ${r.provider} account "${bound.slug}". Unit7 will not use "${r.account}"'s credential there.`);
        }
      }
      const value = app.vault.resolve(orgId, ref);
      redactor.add(value, ref);
      return value;
    },
    credentialFor(provider, accountId) {
      const only = () => { const r = all<AccountRow>(db, 'SELECT * FROM accounts WHERE org_id = ? AND provider = ? LIMIT 2', orgId, provider); return r.length === 1 ? r[0] : undefined; };
      // an explicit account, else the one bound to this environment, else the org's only one of that provider
      const account = accountId
        ? get<AccountRow>(db, 'SELECT * FROM accounts WHERE id = ? AND org_id = ?', accountId, orgId)
        : (env && get<AccountRow>(db, `SELECT a.* FROM environment_accounts ea JOIN accounts a ON a.id = ea.account_id
            WHERE ea.environment_id = ? AND ea.provider = ?`, env.id, provider)) || only();
      if (!account) {
        throw new Unit7Error('no_account', env
          ? `${env.name} has no ${provider} account. Connect one in Connections (one click).`
          : `No ${provider} account is connected. Connect one in Connections (one click).`);
      }
      if (account.provider !== provider) throw forbidden(`Account ${account.name} is a ${account.provider} account, not ${provider}.`);
      // An AI working in a non-production environment (autonomy is usually higher there) may only use accounts a
      // person bound to it: otherwise a new "dev" environment would be a back door to the production account.
      if (isAgent && env && env.kind !== 'production' && !accountAllowed(db, orgId, env.id, account)) {
        throw forbidden(`${env.name} isn't bound to the ${provider} account ${account.name}. A person can bind it in the environment's settings (or work in an environment that uses it).`);
      }
      if (actor.kind !== 'user') { const paused = accountPaused(account); if (paused) throw paused; }
      used.add(account.id);
      const ref = json<{ ref?: string }>(account.meta, {}).ref ?? `credential://${provider}/${account.slug}/token`;
      return { ref, value: ctx.secret(ref), account };
    },
    progress(message) {
      const m = redactor.redact(message);
      o.onProgress?.(m);
      app.events.emit(orgId, 'tool.progress', m, { live: true, projectId, environmentId: env?.id, data: { tool: name } });
    },
    emit(type, message, e = {}) {
      app.events.emit(orgId, type, redactor.redact(message), {
        severity: e.severity, projectId, environmentId: env?.id, resource: e.resource, data: e.data && redactor.redactDeep(e.data),
      });
    },
  };

  const started = Date.now();
  if (o.dryRun) {
    try {
      const plan = tool.dryRun ? await tool.dryRun(ctx, input as never) : { wouldRun: name, input: auditInput, risk, action };
      return { status: 'dry_run', plan: redactor.redactDeep(plan), auditId: audit('dry_run', { output: plan, durationMs: Date.now() - started }) };
    } catch (e) {
      return fail(e);
    }
  }

  // what a fix is about, read before it runs (afterChange)
  let look: (() => Promise<unknown>) | undefined;
  try { look = risk !== 'read' ? afterChange.prepare?.(ctx, name, input) : undefined; } catch { look = undefined; }
  const attempts = 1 + (tool.idempotent ? tool.retries ?? 0 : 0);
  for (let attempt = 1; ; attempt++) {
    const timeoutMs = tool.timeoutMs ?? 60_000;
    const timer = setTimeout(() => ac.abort(new Unit7Error('timeout', `${tool.title} took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`, 504)), timeoutMs);
    try {
      let output = await Promise.race([
        Promise.resolve(commandLog.run(ran, () => tool.run(ctx, input as never))),
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      ]);
      clearTimeout(timer);
      // a change: look again at what it touched, and say whether it's really fixed (never fails the change itself)
      const verified = look && output && typeof output === 'object' && !Array.isArray(output) ? await look().catch(() => undefined) : undefined;
      if (verified) output = { ...(output as object), verified };
      const durationMs = Date.now() - started;
      const safe = shape(output, redactor, false);
      const idle = actor.kind !== 'user' && !!tool.idle?.(output as never);
      const kept = tool.sensitive && safe && typeof safe === 'object' && !Array.isArray(safe) ? { ...safe, ...Object.fromEntries(tool.sensitive.filter((f) => f in safe).map((f) => [f, '[sensitive]'])) } : safe;
      // Warden reads the same things every minute: the row says it happened, the output would only fill the database
      const auditId = idle ? '' : audit('success', { output: risk === 'read' && actor.id === 'warden' ? undefined : kept, durationMs, resources, approvalId });
      if (approvalId) run(db, `UPDATE approvals SET status = 'done', result = 'success' WHERE id = ?`, approvalId);
      if (risk !== 'read' && !idle) {
        app.events.emit(orgId, 'action.completed', `${actor.name}: ${tool.title}`, {
          severity: 'success', projectId, environmentId: env?.id, data: { tool: name, auditId, durationMs },
        });
      }
      // a revealed value goes only to a person signed in to the web app, never to a token (any program on the computer could hold one)
      return { status: 'ok', output: actor.kind === 'user' ? shape(output, redactor, true) : safe, auditId, durationMs };
    } catch (e) {
      clearTimeout(timer);
      const retryable = e instanceof Unit7Error && ((e.detail as { retryable?: boolean })?.retryable ?? e.code === 'connection');
      if (attempt < attempts && retryable && !o.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      return fail(e);
    }
  }

  function fail(e: unknown): ToolResult {
    // a refusal is only pinned on an account when it's clear which one; a rate limit pauses all it used
    if (used.size === 1 || providerTrouble(e) === 'rate') for (const a of used) noteAccountTrouble(app, a, e);
    const err = e instanceof Unit7Error ? e : new Unit7Error('internal', (e as Error)?.message ?? String(e), 500);
    if (!(e instanceof Unit7Error)) console.error(`tool ${name} crashed`, redactor.redact(String((e as Error)?.stack ?? e)));
    const message = redactor.redact(err.message);
    // a step inside this waits for a person: that's where it stands, not a failure
    const waiting = err.code === 'approval_required' ? (err.detail as { approvalId?: string } | undefined)?.approvalId : undefined;
    const auditId = audit(waiting ? 'pending_approval' : 'error', { error: `${err.code}: ${message}`, durationMs: Date.now() - started, resources, approvalId: approvalId ?? waiting });
    if (approvalId) run(db, `UPDATE approvals SET status = 'done', result = ? WHERE id = ?`, `error: ${message}`, approvalId);
    if (waiting) return { status: 'approval_required', approvalId: waiting, why: message };
    if (risk !== 'read') {
      app.events.emit(orgId, 'action.failed', `${tool.title} failed: ${message}`, {
        severity: 'warning', projectId, environmentId: env?.id, data: { tool: name, auditId, code: err.code },
      });
    }
    // a log behind the error (a build's output) rides apart from the plain message: the web shows it under Show details
    const tail = (err.detail as { logTail?: unknown } | undefined)?.logTail;
    return { status: 'error', error: { code: err.code, message, ...(typeof tail === 'string' && tail.trim() && { logTail: redactor.redact(tail).slice(-8000) }) }, auditId };
  }
}

// What a tool only finds out while it runs (a name that's taken, how an app is built) can still ask. The same call goes to
// Approvals and this run stops there, saying so. Approving runs it again, with ctx.approvalId set.
export async function askPerson(ctx: Ctx, tool: string, input: unknown, why: string): Promise<never> {
  const r = await execute(ctx.app, ctx.orgId, ctx.actor, tool, input, { askFirst: why, reason: why, signal: ctx.signal, conversationId: ctx.conversationId });
  if (r.status === 'approval_required') throw new Unit7Error('approval_required', r.why, 409, { approvalId: r.approvalId });
  throw new Unit7Error('denied', r.status === 'denied' ? r.why : r.status === 'error' ? r.error.message : 'That didn’t run.', 403);
}

// A waiting approval that's hard to undo (tier 3: data, or it can't be taken back) asks the person approving it to
// type the thing's name first, like a person asking for it directly does. The Approvals card reads tier + confirm.
export function hardToUndo(db: DB, orgId: string, a: { tool: string; input: string; why: string | null }): { tier: number; confirm?: string } {
  const t = getTool(a.tool), i = viewInput(a.input) as Record<string, unknown>;
  // the tier the gate assessed for this exact request (written into why), riskiest first so added text can only make it stricter
  const named = [4, 3, 2, 1].find((n) => (a.why ?? '').includes(`${TIER_NAMES[n]}.`)) ?? (/hard to undo/i.test(a.why ?? '') ? 3 : undefined);
  const tier = named ?? (t ? tierOf(typeof t.action === 'function' ? t.action(i as never) : t.action, typeof t.risk === 'function' ? t.risk(i as never) : t.risk) : 2);
  if (tier < 3) return { tier };
  const nameIn = (table: string, v: unknown) => (typeof v === 'string' ? get<{ name: string }>(db, `SELECT name FROM ${table} WHERE id = ? AND org_id = ?`, v, orgId)?.name : undefined);
  const backupOf = typeof i.backupId === 'string' ? get<{ name: string }>(db, 'SELECT s.name FROM backups b JOIN services s ON s.id = b.service_id WHERE b.id = ? AND b.org_id = ?', i.backupId, orgId)?.name : undefined;
  // an X-ray part id ("c:shop-db-1", "unit:worker.service") as the name people see
  const part = typeof i.part === 'string' ? i.part.replace(/^(stack:.*:|[a-z0-9]+:)/, '').replace(/\.service$/, '') : undefined;
  // a Coolify thing's own name, which its tool also checks before acting
  const own = typeof i.confirmName === 'string' && i.confirmName.trim() ? i.confirmName.trim() : undefined;
  const confirm = part ?? own ?? nameIn('services', i.serviceId) ?? backupOf ?? nameIn('servers', i.serverId) ?? nameIn('projects', i.projectId) ?? nameIn('environments', i.environmentId);
  return { tier, ...(confirm && { confirm }) };
}

// A human decides on a pending approval. Approving runs the action right away, as the original
// actor, with the approver recorded.
export async function decideApproval(app: App, orgId: string, approver: Actor, approvalId: string, approve: boolean, confirm?: string): Promise<ToolResult | { status: 'rejected' }> {
  const a = get<{ status: string; tool: string; input: string; actor: string; environment_id: string | null; expires_at: string; why: string | null }>(app.db,
    'SELECT status, tool, input, actor, environment_id, expires_at, why FROM approvals WHERE id = ? AND org_id = ?', approvalId, orgId);
  if (!a) throw notFound('That approval');
  if (a.status !== 'pending') throw new Unit7Error('approval_closed', `That approval is already ${a.status}.`, 409);
  if (a.expires_at < now()) {
    run(app.db, `UPDATE approvals SET status = 'expired' WHERE id = ?`, approvalId);
    throw new Unit7Error('approval_expired', 'That approval expired. Ask for the action again.', 410);
  }
  if (approver.kind !== 'user' || approver.role === 'agent') throw forbidden('Only a person can approve an action, signed in to Unit7 (not with a token).');
  const env = a.environment_id ? get<{ kind: string }>(app.db, 'SELECT kind FROM environments WHERE id = ?', a.environment_id) : undefined;
  const needsAdmin = !env || env.kind === 'production';
  if (!(isAdmin(approver.role) || (approver.role === 'developer' && !needsAdmin))) {
    throw forbidden(needsAdmin ? 'Only an owner or admin can approve production and org-wide actions.' : 'Your role cannot approve actions.');
  }
  // hard to undo: the person approving types its name, checked here so every way of approving (page, phone, API) needs it
  const hard = approve ? hardToUndo(app.db, orgId, a) : { tier: 0 };
  if (hard.confirm && (confirm ?? '').trim().toLowerCase() !== hard.confirm.toLowerCase()) {
    throw new Unit7Error('confirm_needed', `This is hard to undo. Type the name (${hard.confirm}) on the Approvals page to approve it.`, 400, { confirm: hard.confirm });
  }
  run(app.db, `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`, approve ? 'approved' : 'rejected', approver.name, now(), approvalId);
  app.events.emit(orgId, approve ? 'approval.approved' : 'approval.rejected', `${approver.name} ${approve ? 'approved' : 'rejected'} ${a.tool}`, {
    severity: 'info', environmentId: a.environment_id, resource: approvalId,
  });
  if (!approve) return { status: 'rejected' };
  const original = JSON.parse(a.actor) as Actor;
  // an AI's delete waits, even after a yes (ops/index.ts): a person can still stop it for 48 hours
  if (original.kind !== 'user' && holds?.isHeld(a.tool, openInput(app, orgId, approvalId, a.input), original)) return { status: 'ok', output: { held: true, until: holds.hold(app, orgId, { id: approvalId, tool: a.tool, actor: original, by: approver.name }), note: 'It waits 48 hours, and you can cancel it until then.' }, auditId: '', durationMs: 0 };
  return execute(app, orgId, { ...original, name: `${original.name} (approved by ${approver.name})` }, a.tool, openInput(app, orgId, approvalId, a.input), { approvalId });
}
