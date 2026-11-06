// "Let Unit7 fix it" on a phone alert. A problem alert (a site down, an anomaly, a failed deploy, a serious finding)
// carries one more button. Tapping it is the person's own request, so it starts an investigation as them, on their own
// chosen AI, exactly as if they had typed it in the web app. The AI looks first, read-only; then it proposes ONE fix,
// which is an ordinary gated tool call that waits for their OK (the gate turns any change in that thread into an
// approval, and refuses a second one), so it comes back to the phone with Approve / Not now. After the fix runs Unit7
// checks again and says "Fixed: …" or "Didn't work: …". The button carries a code only Unit7 can make (the phone
// approvals key), works once, and expires; one investigation per problem every 30 minutes. Everything shows in
// Activity and in the person's thread.
import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import type { Unit7Event } from '../events.ts';
import { get, id, json, now, run, tx } from '../db.ts';
import { PHONE_FIX_OPEN } from '../tools/runtime.ts';
import { PENDING_STALE_MS } from '../agent/bridge.ts';
import { phoneCode } from '../sentinel/phone.ts';
import { probe as liveProbe } from '../sentinel/watch.ts';
import { untrusted } from '../agent/escalate.ts';
import { Redactor } from '../redact.ts';
import type { Principal } from '../auth.ts';
import type { Role } from '../policy.ts';

// the problems worth a "fix it" button (the rest of the alerts are news, a reminder or need a person anyway)
const FIXABLE = new Set(['site.down', 'site.slow', 'service.down', 'server.unreachable', 'deployment.failed', 'watch.anomaly', 'watch.traffic',
  'watch.finding', 'security.found', 'app.errors', 'domain.broken', 'server.disk_high', 'backup.failed', 'backup.verify_failed']);
const OFFER_MS = 12 * 3600_000; // ntfy keeps a message 12 hours: a button older than that is never tapped
const EVERY_MS = 30 * 60_000;   // one investigation per problem per 30 minutes
const LOOK_MS = PENDING_STALE_MS; // how long a thread stays "propose only" if the AI never says it's done: as long as its inbox request can wait
const NOT_OURS = 'That button wasn’t from Unit7, so nothing was done.';

export interface FixRow {
  id: string; org_id: string; account_id: string; user_id: string; problem: string; type: string; resource: string | null; title: string; message: string;
  status: string; conversation_id: string | null; via: string | null; approval_id: string | null; outcome: string | null; expires_at: string; started_at: string | null;
}
export const fixCode = (app: App, orgId: string, fixId: string) => phoneCode(app, orgId, `fix:${fixId}`);

// A serious finding only: a watch finding that's only medium (or a tip) isn't worth waking an AI for
function fixable(e: Unit7Event) {
  if (!FIXABLE.has(e.type)) return false;
  if (e.type === 'watch.finding') return e.severity === 'critical' || ((e.data.alerts as { severity?: string }[] | undefined) ?? []).some((a) => a.severity === 'high' || a.severity === 'critical');
  return e.severity !== 'info' && e.severity !== 'success';
}

// The ntfy button for one problem alert (and the single-use offer behind it), or undefined when it gets none
export function fixAction(app: App, e: Unit7Event, o: { title: string; text: string; replies: string; accountId: string; approver: string }) {
  if (!fixable(e)) return undefined;
  const fixId = id('fix');
  run(app.db, `INSERT INTO care_fixes (id, org_id, account_id, user_id, problem, type, resource, title, message, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fixId, e.org_id, o.accountId, o.approver, `${e.type}:${e.resource ?? ''}`, e.type, e.resource ?? null, o.title, o.text, new Date(Date.now() + OFFER_MS).toISOString());
  return `http, Let Unit7 fix it, ${o.replies}, method=POST, body=fix ${fixId} ${fixCode(app, e.org_id, fixId)}, clear=true`;
}

function principalOf(app: App, orgId: string, userId: string): Principal | undefined {
  const r = get<{ uid: string; email: string; uname: string; oid: string; oname: string; slug: string; role: Role }>(app.db,
    `SELECT u.id uid, u.email, u.name uname, o.id oid, o.name oname, o.slug, m.role FROM users u JOIN memberships m ON m.user_id = u.id JOIN orgs o ON o.id = m.org_id
     WHERE u.id = ? AND o.id = ?`, userId, orgId);
  return r && { user: { id: r.uid, email: r.email, name: r.uname }, org: { id: r.oid, name: r.oname, slug: r.slug }, role: r.role, via: 'session' };
}

// What the AI is asked: the person's words, with the alert's own text fenced off as data
export const briefFor = (f: Pick<FixRow, 'title' | 'message'>) => `From my phone I tapped “Let Unit7 fix it” on this alert: ${f.title}.
${untrusted('the alert', f.message)}
Please:
1. Look first, read-only: what is wrong and why (status, logs, recent deploys and changes, usage). Change nothing while you look.
2. Then propose ONE fix: call the one tool that makes it. It won’t run yet: it waits for my OK on my phone. Don’t propose a second one.
3. Tell me in two short lines what you found and what the fix does.
Never buy anything, change a plan or delete data as the fix. If there is no safe fix, say what I should do instead.`;

// One tap on "Let Unit7 fix it": "fix fix_… <code>". Returns what to tell the phone, or undefined when it isn't one.
export async function handleFixTap(app: App, acc: { id: string; orgId: string; approver: string }, text: string): Promise<string | undefined> {
  const m = /^fix (fix_[\w-]{12}) ([\w-]{22})$/.exec(text.trim());
  if (!m) return text.trim().startsWith('fix ') ? NOT_OURS : undefined;
  const [, fixId, code] = m as unknown as [string, string, string];
  const want = Buffer.from(fixCode(app, acc.orgId, fixId)), got = Buffer.from(code);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return NOT_OURS;
  const f = get<FixRow>(app.db, 'SELECT * FROM care_fixes WHERE id = ? AND org_id = ? AND account_id = ?', fixId, acc.orgId, acc.id);
  if (!f) return NOT_OURS;
  // single use, expiring, and at most one look per problem every 30 minutes (checked and claimed in one step)
  const why = tx(app.db, () => {
    if (f.status !== 'offered') return 'That button was already used. Open Unit7 to follow it.';
    if (f.expires_at < now()) return 'That alert is too old to act on. Open Unit7 to look.';
    const last = get<{ started_at: string }>(app.db, 'SELECT started_at FROM care_fixes WHERE org_id = ? AND problem = ? AND started_at > ? ORDER BY started_at DESC LIMIT 1',
      acc.orgId, f.problem, new Date(Date.now() - EVERY_MS).toISOString());
    if (last) return `Unit7 already started looking at this ${Math.max(1, Math.round((Date.now() - Date.parse(last.started_at)) / 60_000))} min ago. It looks at one problem at most every 30 minutes.`;
    return run(app.db, `UPDATE care_fixes SET status = 'looking', started_at = ? WHERE id = ? AND status = 'offered'`, now(), fixId).changes ? undefined : 'That button was already used. Open Unit7 to follow it.';
  });
  if (why) return why;
  // the person who set up phone approvals is who tapped it: their request, their brain
  const p = principalOf(app, acc.orgId, f.user_id);
  if (!p || p.role === 'readonly' || p.role === 'auditor') { finish(app, fixId, 'failed', 'nobody to ask'); return 'The person who set up phone approvals can’t make changes here any more, so nothing was done.'; }
  const { sendToAgent } = await import('../agent/conversations.ts');
  let r: Awaited<ReturnType<typeof sendToAgent>>;
  try { r = await sendToAgent(app, p, briefFor(f)); } catch (e) { finish(app, fixId, 'failed', (e as Error).message); return `Unit7 couldn’t start looking: ${(e as Error).message.slice(0, 160)}`; }
  // propose-only for that conversation alone, kept on the fix's row (the gate reads it there)
  run(app.db, 'UPDATE care_fixes SET conversation_id = ?, via = ?, look_until = ? WHERE id = ?', r.conversationId, r.via, new Date(Date.now() + LOOK_MS).toISOString(), fixId);
  app.events.emit(acc.orgId, 'care.fix_started', `${p.user.name} asked Unit7 to fix it from their phone: ${f.title}. Unit7 looks first, then sends one fix to approve.`,
    { severity: 'info', resource: f.resource, data: { fixId, conversationId: r.conversationId } });
  return r.via === 'your-ai' && !r.watching ? 'It’s waiting in your AI’s inbox: it starts when your AI is watching. You’ll get one fix to approve here.' : 'Looking into it now. You’ll get one fix to approve here.';
}

const finish = (app: App, fixId: string, status: string, outcome?: string) =>
  run(app.db, 'UPDATE care_fixes SET status = ?, outcome = coalesce(?, outcome), finished_at = ? WHERE id = ?', status, outcome ?? null, now(), fixId);

export interface CareOptions {
  probe?: (host: string) => Promise<{ ok: boolean; ms: number; why?: string }>;
  send?: typeof fetch;
  pollMs?: number;   // how often to look whether the approved fix finished
  settleMs?: number; // how long to give it before checking again (a restarted app needs a moment)
}

// Did the fix work? Asked of the thing itself where Unit7 can (the site answers, the app runs, the deploy is live).
async function recheck(app: App, f: FixRow, o: CareOptions): Promise<{ ok: boolean; text: string }> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());
  if ((f.type === 'site.down' || f.type === 'site.slow') && f.resource) {
    let last: { ok: boolean; ms: number; why?: string } = { ok: false, ms: 0 };
    for (let i = 0; i < 3; i++) {
      await wait(i ? (o.settleMs ?? 20_000) : Math.min(o.settleMs ?? 20_000, 5_000));
      last = await (o.probe ?? liveProbe)(f.resource);
      if (last.ok) return { ok: true, text: `Fixed: ${f.resource} answers again (${last.ms} ms).` };
    }
    return { ok: false, text: `Didn’t work: ${f.resource} still isn’t answering (${last.why ?? 'no answer'}). Open Unit7 to look further.` };
  }
  if ((f.type === 'service.down' || f.type === 'deployment.failed') && f.resource) {
    await wait(o.settleMs ?? 20_000);
    const s = get<{ name: string; status: string }>(app.db, 'SELECT name, status FROM services WHERE id = ?', f.resource);
    if (s) return s.status === 'healthy' ? { ok: true, text: `Fixed: ${s.name} is running again.` } : { ok: false, text: `Didn’t work: ${s.name} is still ${s.status}. Open Unit7 to look further.` };
  }
  return { ok: true, text: 'Done. Unit7 keeps watching it and tells you if it comes back.' };
}

// Tell the person on every surface: their phone (where the buttons were), their thread, and Activity
async function tell(app: App, f: FixRow, ok: boolean, text: string, o: CareOptions) {
  const clean = new Redactor().redact(text).slice(0, 400);
  if (f.conversation_id) {
    const msg = { id: id('msg'), role: 'status', content: { tone: ok ? 'ok' : 'bad', text: clean }, created_at: now() };
    run(app.db, 'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)', msg.id, f.conversation_id, msg.role, JSON.stringify(msg.content), msg.created_at);
    app.events.emit(f.org_id, 'agent.message', '', { live: true, data: { conversationId: f.conversation_id, message: msg } });
  }
  app.events.emit(f.org_id, ok ? 'care.fixed' : 'care.fix_failed', `${f.title}: ${clean}`, { severity: ok ? 'success' : 'warning', resource: f.resource, data: { fixId: f.id, conversationId: f.conversation_id } });
  const acc = get<{ meta: string }>(app.db, 'SELECT meta FROM accounts WHERE id = ? AND org_id = ?', f.account_id, f.org_id);
  try {
    const url = app.vault.resolve(f.org_id, json<{ ref?: string }>(acc?.meta, {}).ref!);
    await (o.send ?? fetch)(url, { method: 'POST', body: clean, headers: { Title: 'Unit7', Tags: ok ? 'white_check_mark' : 'x' }, signal: AbortSignal.timeout(10_000) });
  } catch { /* the thread and Activity have it either way */ }
}

// After the person said OK: wait for the fix to finish, check again, and say how it went
export async function followUp(app: App, fixId: string, o: CareOptions = {}) {
  run(app.db, `UPDATE care_fixes SET status = 'fixing' WHERE id = ?`, fixId);
  const f = get<FixRow>(app.db, 'SELECT * FROM care_fixes WHERE id = ?', fixId)!;
  const until = Date.now() + 40 * 60_000; // the longest tools run about 30 minutes
  // ponytail: polls the approval row; an event from the gate when an approved action finishes is the upgrade
  let a: { status: string; result: string | null } | undefined;
  for (;;) {
    a = get(app.db, 'SELECT status, result FROM approvals WHERE id = ?', f.approval_id ?? '');
    if (!a || a.status === 'done' || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, o.pollMs ?? 2000).unref());
  }
  const r = a?.status === 'done' && a.result === 'success' ? await recheck(app, f, o)
    : { ok: false, text: `Didn’t work: ${a?.result?.replace(/^error: /, '') || 'the fix didn’t finish'}.` };
  finish(app, fixId, r.ok ? 'fixed' : 'failed', r.text);
  await tell(app, f, r.ok, r.text, o);
  return r;
}

// Follow each investigation through the gate's events: the fix it proposed, the person's answer, the end of its run
export function startCare(app: App, o: CareOptions = {}) {
  return app.events.on((e) => {
    if (e.type === 'approval.requested' && e.data.phoneFix && typeof e.data.conversationId === 'string') {
      run(app.db, `UPDATE care_fixes SET status = 'proposed', approval_id = ? WHERE org_id = ? AND conversation_id = ? AND status = 'looking'`, e.resource ?? null, e.org_id, e.data.conversationId);
      return;
    }
    if ((e.type === 'approval.approved' || e.type === 'approval.rejected') && e.resource) {
      const f = get<FixRow>(app.db, `SELECT * FROM care_fixes WHERE org_id = ? AND approval_id = ? AND status = 'proposed'`, e.org_id, e.resource);
      if (!f) return;
      if (e.type === 'approval.approved') void followUp(app, f.id, o).catch((err) => console.error('phone fix follow-up', err));
      else { finish(app, f.id, 'declined', 'Not now: nothing was changed.'); app.events.emit(e.org_id, 'care.declined', `${f.title}: you said not now, so nothing was changed.`, { severity: 'info', resource: f.resource, data: { fixId: f.id, conversationId: f.conversation_id } }); }
      return;
    }
    if (e.type === 'agent.done' && typeof e.data.conversationId === 'string') {
      const conv = e.data.conversationId;
      run(app.db, `UPDATE care_fixes SET look_until = ? WHERE org_id = ? AND conversation_id = ? AND ${PHONE_FIX_OPEN}`, now(), e.org_id, conv);
      const f = get<FixRow>(app.db, `SELECT * FROM care_fixes WHERE org_id = ? AND conversation_id = ? AND status = 'looking'`, e.org_id, conv);
      if (f) { finish(app, f.id, 'no_fix'); void tell(app, f, false, 'Unit7 looked but has no safe fix to send. What it found is in the web app.', o); }
    }
  });
}
