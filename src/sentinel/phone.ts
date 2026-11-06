// Approve from your phone without opening this computer to the internet. The "Waiting for your OK" alert
// (ntfy) carries Approve / Reject buttons. Tapping one makes your phone post a reply to a second private
// channel; Unit7, which only ever connects out, listens there and decides as you. Each button carries
// a one-time code only Unit7 can make (an HMAC of the approval and the decision, keyed in the vault), so
// knowing the reply channel is not enough to approve anything, and a code works for one decision only.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import { all, get, json, run } from '../db.ts';
import { makeRef } from '../vault.ts';
import { Unit7Error } from '../errors.ts';
import { decideApproval, type Actor } from '../tools/runtime.ts';
import type { Role } from '../policy.ts';

const KEY_REF = makeRef('forge', 'phone', 'key');
function key(app: App, orgId: string) {
  try { return Buffer.from(app.vault.resolve(orgId, KEY_REF), 'base64'); } catch {
    const k = randomBytes(32);
    app.vault.put(orgId, KEY_REF, k.toString('base64'), { kind: 'phone_key', by: 'phone approvals' });
    return k;
  }
}
export const codeFor = (app: App, orgId: string, approvalId: string, decision: 'approve' | 'reject') =>
  createHmac('sha256', key(app, orgId)).update(`${approvalId}:${decision}`).digest('base64url').slice(0, 22);
// the same kind of code for another phone button ("Let Unit7 fix it": `fix:<id>`), from the same key
export const phoneCode = (app: App, orgId: string, what: string) =>
  createHmac('sha256', key(app, orgId)).update(what).digest('base64url').slice(0, 22);

// by: who set it up. proof: when the phone (a tap on "It worked") or that person ("I got it") showed a test arrived;
// only then is it "connected". check: the one test waiting for its answer (single use, expires). miss: the last
// alert ntfy (or a team chat) refused. repliesRef: the reply channel, a second private topic kept in the vault.
export interface PhoneMeta { ref?: string; replies?: string; repliesRef?: string; approver?: string; lastReply?: string; by?: string;
  proof?: { at: string; how: 'phone' | 'person' }; check?: { nonce: string; until: string }; miss?: { at: string; why: string } }
const metaOf = (app: App, accountId: string) => json<PhoneMeta>(get<{ meta: string }>(app.db, 'SELECT meta FROM accounts WHERE id = ?', accountId)?.meta ?? '{}', {});
const setMeta = (app: App, accountId: string, m: PhoneMeta) => run(app.db, 'UPDATE accounts SET meta = ? WHERE id = ?', JSON.stringify(m), accountId);
const repliesOf = (app: App, orgId: string, m: PhoneMeta) => { try { return m.repliesRef ? app.vault.resolve(orgId, m.repliesRef) : undefined; } catch { return undefined; } };
// listened to: a phone that proved it gets alerts and has approvals on, or one with a test waiting for its tap
const phoneAccounts = (app: App, orgId?: string) => all<{ id: string; org_id: string; meta: string }>(app.db,
  `SELECT id, org_id, meta FROM accounts WHERE provider = 'ntfy' AND (? IS NULL OR org_id = ?)`, orgId ?? null, orgId ?? null)
  .map((a) => { const m = json<PhoneMeta>(a.meta, {}); return { ...a, m: { ...m, replies: repliesOf(app, a.org_id, m) } }; })
  .filter((a) => a.m.replies && ((a.m.approver && a.m.proof) || a.m.check));
// the buttons an alert may carry (Approve / Reject, Let Unit7 fix it): only on a phone that proved it gets alerts
export function phoneButtons(app: App, orgId: string, meta: string) {
  const m = json<PhoneMeta>(meta, {});
  const replies = m.approver && m.proof ? repliesOf(app, orgId, m) : undefined;
  return replies ? { replies, approver: m.approver! } : undefined;
}

export const whyAction = (app: App, e: { id: string; org_id: string }, repliesUrl: string) => `http, Why?, ${repliesUrl}, method=POST, body=why ${e.id} ${phoneCode(app, e.org_id, `why:${e.id}`)}, clear=false`;

// ntfy action buttons for an approval alert (sent with the alert itself)
export function approvalButtons(app: App, orgId: string, approvalId: string, repliesUrl: string, no = 'Reject', yes = 'Approve') {
  const b = (label: string, d: 'approve' | 'reject') => `http, ${label}, ${repliesUrl}, method=POST, body=${d} ${approvalId} ${codeFor(app, orgId, approvalId, d)}, clear=true`;
  return `${b(yes, 'approve')}; ${b(no, 'reject')}`;
}
export const repliesFor = (app: App, orgId: string) => phoneAccounts(app, orgId)[0]?.m.replies;

// a private ntfy topic: long and random, so nobody can guess it (it's a secret: vault only)
export const newTopic = (prefix: string) => `https://ntfy.sh/${prefix}${randomBytes(18).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
// The reply channel, made once and kept in the vault (separate from the alerts topic). A reply channel saved in plain
// text by an older Unit7 is dropped for a new one.
export function ensureReplies(app: App, orgId: string, accountId: string) {
  const a = get<{ slug: string; meta: string }>(app.db, `SELECT slug, meta FROM accounts WHERE id = ? AND org_id = ? AND provider = 'ntfy'`, accountId, orgId);
  if (!a) throw new Unit7Error('no_account', 'Set up phone alerts first (Connections → Phone alerts).', 409);
  const m = json<PhoneMeta>(a.meta, {});
  const have = repliesOf(app, orgId, m);
  if (have) return have;
  const ref = makeRef('ntfy', a.slug, 'replies'), url = newTopic('unit7-r-');
  app.vault.put(orgId, ref, url, { kind: 'ntfy_replies', accountId, by: 'phone alerts' });
  const { replies: _plain, lastReply: _l, ...rest } = m;
  setMeta(app, accountId, { ...rest, repliesRef: ref });
  return url;
}

// Turn phone approvals on for an alerts channel (the person who decides), or off. Only on a phone that proved it gets
// alerts: buttons on alerts that never arrive would be a promise Unit7 can't keep.
export function enablePhoneApprovals(app: App, orgId: string, accountId: string, approverUserId: string | null) {
  const a = get<{ meta: string }>(app.db, `SELECT meta FROM accounts WHERE id = ? AND org_id = ? AND provider = 'ntfy'`, accountId, orgId);
  if (!a) return false;
  if (approverUserId && !json<PhoneMeta>(a.meta, {}).proof) throw new Unit7Error('phone_not_checked', 'Your phone hasn’t shown it gets alerts yet. Open Connections → Phone alerts, send a test and tap “It worked”.', 409);
  if (approverUserId) ensureReplies(app, orgId, accountId);
  const m = metaOf(app, accountId);
  setMeta(app, accountId, approverUserId ? { ...m, approver: approverUserId } : (({ approver: _a, ...rest }) => rest)(m));
  return true;
}

// --- proving the phone gets alerts --------------------------------------------------------------------------------------
// A test alert with an "It worked" button. The tap posts `verify <nonce> <code>` to the reply channel: the code is the
// same kind of HMAC as the approval buttons, for this account and this one test, which works once and for 30 minutes.
// (ntfy shows buttons on Android and the web, not on iPhone: there the person says "I got it" in Unit7.)
export const CHECK_MS = 30 * 60_000;
let wake: (() => void) | undefined; // the reply listener, told at once that a test is waiting for its tap
const reason = (e: unknown, who = 'ntfy') => { const s = /HTTP (\d{3})/.exec(String((e as Error)?.message ?? e))?.[1]; return s ? `${who} answered HTTP ${s}` : `Unit7 couldn’t reach ${who}`; };
export async function sendPhoneTest(app: App, orgId: string, accountId: string, f: typeof fetch = fetch) {
  const replies = ensureReplies(app, orgId, accountId);
  const nonce = randomBytes(9).toString('base64url'), until = new Date(Date.now() + CHECK_MS).toISOString();
  const m = metaOf(app, accountId);
  setMeta(app, accountId, { ...m, check: { nonce, until } });
  wake?.();
  try {
    const r = await f(app.vault.resolve(orgId, m.ref!), { method: 'POST', body: 'Unit7 test: tap “It worked”. On an iPhone, tap “I got it” in Unit7 instead.',
      headers: { Title: 'Unit7 test', Priority: '4', Tags: 'wave', Actions: `http, It worked, ${replies}, method=POST, body=verify ${nonce} ${phoneCode(app, orgId, `verify:${accountId}:${nonce}`)}, clear=true` },
      signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    missed(app, orgId, accountId, reason(e));
    throw new Unit7Error('phone_unreachable', `${reason(e)}. Try again in a minute.`, 502);
  }
  missed(app, orgId, accountId, null);
  return { sent: true, until };
}

// The phone (or the person) showed the test arrived: connected, with the date. The first time, phone approvals turn on
// for the person who set it up (as setting it up used to do at once).
export function confirmPhone(app: App, orgId: string, accountId: string, how: 'phone' | 'person') {
  const m = metaOf(app, accountId);
  const { check: _c, miss: _m, ...rest } = m;
  const at = new Date().toISOString();
  setMeta(app, accountId, { ...rest, proof: { at, how } });
  run(app.db, `UPDATE accounts SET status = 'verified', verified_at = ? WHERE id = ?`, at, accountId);
  if (!m.proof && m.by && !m.approver) try { enablePhoneApprovals(app, orgId, accountId, m.by); } catch { /* the switch stays off */ }
  app.events.emit(orgId, 'account.phone_verified', how === 'phone' ? 'Phone alerts work: your phone answered the test' : 'Phone alerts work: you saw the test arrive', { severity: 'success', resource: accountId });
  return at;
}

// An alert channel stopped taking alerts (an HTTP error, or nothing answered), or works again (why = null). Said once
// in Activity when it starts; the channel's address is never part of it.
export function missed(app: App, orgId: string, accountId: string, why: string | null) {
  const a = get<{ name: string; provider: string; meta: string }>(app.db, 'SELECT name, provider, meta FROM accounts WHERE id = ? AND org_id = ?', accountId, orgId);
  if (!a) return;
  const m = json<PhoneMeta>(a.meta, {});
  if (!why) {
    if (m.miss) setMeta(app, accountId, (({ miss: _m, ...rest }) => rest)(m));
    // a team chat that took a message works (a 2xx is the proof there); a phone still needs its own test
    run(app.db, `UPDATE accounts SET status = 'verified', verified_at = ? WHERE id = ? AND provider = 'webhook' AND status != 'verified'`, new Date().toISOString(), accountId);
    return;
  }
  setMeta(app, accountId, { ...m, miss: { at: new Date().toISOString(), why } });
  if (!m.miss) app.events.emit(orgId, 'account.alerts_missed', `${a.provider === 'ntfy' ? 'Alerts aren’t reaching your phone' : `${a.name} isn’t reaching you`}: ${why}`, { severity: 'warning', resource: accountId });
}
export const missReason = reason;

// What the Connections page shows for an alert channel: verified (with when), waiting for the phone, or not reaching it.
export function alertState(provider: string, status: string, verifiedAt: string | null, meta: string) {
  const m = json<PhoneMeta>(meta, {});
  // proof: when a test last got through (kept while failing, so a new one can be told apart)
  const proof = (provider === 'ntfy' ? m.proof?.at : verifiedAt) ?? null, testUntil = m.check?.until ?? null;
  if (m.miss) return { state: 'failing' as const, at: m.miss.at, why: m.miss.why, proof, testUntil };
  if (status === 'failing') return { state: 'failing' as const, at: null, why: null, proof, testUntil };
  const proved = provider === 'ntfy' ? m.proof?.at : status === 'verified' ? verifiedAt : undefined;
  return proved ? { state: 'verified' as const, at: proved, why: null, proof, testUntil } : { state: 'waiting' as const, at: null, why: null, proof, testUntil };
}

// phone alerts count as set up only once a channel proved it receives them (a test got through), not when one merely exists
export const alertsVerified = (db: App['db'], orgId: string) => all<{ provider: string; status: string; verified_at: string | null; meta: string }>(db,
  `SELECT provider, status, verified_at, meta FROM accounts WHERE org_id = ? AND provider IN ('ntfy', 'webhook')`, orgId).some((a) => alertState(a.provider, a.status, a.verified_at, a.meta).state === 'verified');

// One reply from the phone: "approve apr_… <code>". Returns what happened, for the confirmation alert.
export async function handleReply(app: App, accountId: string, text: string): Promise<string | undefined> {
  const acc = phoneAccounts(app).find((a) => a.id === accountId);
  // "It worked" on the test alert: this phone gets alerts. The code is for this one test; it works once, for 30 minutes.
  const v = /^verify ([\w-]{12}) ([\w-]{22})$/.exec(text.trim());
  if (acc && v) {
    const want = Buffer.from(phoneCode(app, acc.org_id, `verify:${acc.id}:${v[1]}`)), got = Buffer.from(v[2]!);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return 'That button wasn’t from Unit7, so nothing was done.';
    if (acc.m.check?.nonce !== v[1]) return 'That test was already answered. Send a new one from Unit7 if you need to.';
    if (Date.parse(acc.m.check.until) < Date.now()) return 'That test is too old. Send a new one from Unit7.';
    confirmPhone(app, acc.org_id, acc.id, 'phone');
    return 'All set: Unit7 alerts reach this phone.';
  }
  if (acc && !(acc.m.approver && acc.m.proof)) return undefined; // waiting for its test: nothing else is answered yet
  // "Let Unit7 fix it" on a problem alert: an investigation as this person (care/phonefix.ts)
  // "Why?" on an alert: the reason, in plain words, from the record. It changes nothing and needs no AI.
  const why = acc ? /^why (\S{6,40}) ([\w-]{22})$/.exec(text.trim()) : null;
  if (acc && why) {
    const want = Buffer.from(phoneCode(app, acc.org_id, `why:${why[1]!}`)), got = Buffer.from(why[2]!);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return 'That button wasn’t from Unit7, so nothing was done.';
    return (await import('./telegram.ts')).whyText(app, acc.org_id, why[1]!);
  }
  if (acc && /^fix /.test(text.trim())) return (await import('../care/phonefix.ts')).handleFixTap(app, { id: acc.id, orgId: acc.org_id, approver: acc.m.approver! }, text);
  // Promote / Roll back on a canary's alert (src/fleet/canary.ts), as the person who set up phone approvals
  if (acc && /^canary /.test(text.trim())) return (await import('../fleet/canary.ts')).handleCanaryTap(app, { orgId: acc.org_id, approver: acc.m.approver! }, text);
  const m = /^(approve|reject) (apr_[\w-]{12}) ([\w-]{22})$/.exec(text.trim());
  if (!acc || !m) return undefined;
  const [, decision, approvalId, code] = m as unknown as [string, 'approve' | 'reject', string, string];
  const want = Buffer.from(codeFor(app, acc.org_id, approvalId, decision)), got = Buffer.from(code);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'That button wasn’t from Unit7, so nothing was done.';
  const user = get<{ id: string; name: string; role: Role }>(app.db, 'SELECT u.id, u.name, m.role FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.id = ? AND m.org_id = ?', acc.m.approver!, acc.org_id);
  if (!user) return 'The person who set up phone approvals is no longer in this organisation.';
  const actor: Actor = { kind: 'user', id: user.id, userId: user.id, name: `${user.name} (from phone)`, role: user.role };
  const a = get<{ tool: string }>(app.db, 'SELECT tool FROM approvals WHERE id = ?', approvalId);
  try {
    const r = await decideApproval(app, acc.org_id, actor, approvalId, decision === 'approve');
    if (r.status === 'rejected') return `Rejected: ${a?.tool}. Nothing was done.`;
    return r.status === 'ok' ? `Approved and done: ${a?.tool}.` : r.status === 'error' ? `Approved, but it failed: ${r.error.message.slice(0, 160)}` : `Approved: ${a?.tool} (${r.status}).`;
  } catch (e) { return (e as Error).message.slice(0, 200); }
}

// Listen on every reply channel. Outgoing connections only: a stream from ntfy, reconnected with backoff,
// resuming from the last reply handled (ntfy keeps messages for 12 hours, so a restart misses nothing).
export function startPhoneApprovals(app: App, o: { fetch?: typeof fetch } = {}) {
  const f = o.fetch ?? fetch;
  const streams = new Map<string, AbortController>(); // account id -> its stream
  const listen = async (accountId: string, ac: AbortController) => {
    for (let wait = 5_000; !ac.signal.aborted; wait = Math.min(wait * 2, 60_000)) {
      try {
        const acc = phoneAccounts(app).find((a) => a.id === accountId);
        if (!acc) return;
        const res = await f(`${acc.m.replies}/json?since=${acc.m.lastReply ?? '10m'}`, { signal: ac.signal });
        if (!res.ok || !res.body) throw new Error(`ntfy said ${res.status}`);
        const opened = Date.now();
        let buf = '';
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += Buffer.from(chunk).toString('utf8');
          for (let i; (i = buf.indexOf('\n')) !== -1; buf = buf.slice(i + 1)) {
            const msg = json<{ id?: string; event?: string; message?: string }>(buf.slice(0, i), {});
            if (msg.event !== 'message' || !msg.id) continue;
            const outcome = await handleReply(app, accountId, msg.message ?? '');
            const meta = json<PhoneMeta>(get<{ meta: string }>(app.db, 'SELECT meta FROM accounts WHERE id = ?', accountId)?.meta ?? '{}', {});
            run(app.db, 'UPDATE accounts SET meta = ? WHERE id = ?', JSON.stringify({ ...meta, lastReply: msg.id }), accountId);
            if (outcome) await confirm(app, accountId, outcome, f);
          }
        }
        // only a stream that stayed open a while counts as healthy: one closed at once still backs off
        if (Date.now() - opened > 5 * 60_000) wait = 5_000;
      } catch { /* dropped or ntfy is down: try again */ }
      if (!ac.signal.aborted) await new Promise((r) => setTimeout(r, wait).unref());
    }
  };
  const sync = () => {
    const want = new Set(phoneAccounts(app).map((a) => a.id));
    for (const [id, ac] of streams) if (!want.has(id)) { ac.abort(); streams.delete(id); }
    for (const id of want) if (!streams.has(id)) { const ac = new AbortController(); streams.set(id, ac); void listen(id, ac); }
  };
  sync();
  const timer = setInterval(sync, 30_000);
  timer.unref();
  wake = sync;
  return { stop: () => { clearInterval(timer); if (wake === sync) wake = undefined; for (const ac of streams.values()) ac.abort(); streams.clear(); }, sync };
}

// tell the phone what happened (on the alerts channel, so it shows up where the buttons were)
async function confirm(app: App, accountId: string, text: string, f: typeof fetch) {
  const acc = get<{ org_id: string; meta: string }>(app.db, 'SELECT org_id, meta FROM accounts WHERE id = ?', accountId);
  if (!acc) return;
  try {
    const url = app.vault.resolve(acc.org_id, json<PhoneMeta>(acc.meta, {}).ref!);
    await f(url, { method: 'POST', body: text, headers: { Title: 'Unit7', Tags: /^Approved and done/.test(text) ? 'white_check_mark' : 'information_source' }, signal: AbortSignal.timeout(10_000) });
  } catch { /* the decision stands either way */ }
}
