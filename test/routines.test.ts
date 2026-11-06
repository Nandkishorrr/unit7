// Saved routines: schedules in plain words, runs as the owner through the gate (an approval waits, then the run goes
// on), what a routine may never do, pausing after three failures, saving a conversation's steps, and the brain rule.
import { runHeld } from '../src/ops/index.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, get, id, run } from '../src/db.ts';
import { decideApproval } from '../src/tools/runtime.ts';
import { parseSchedule, nextRun, runRoutine, tick, brainFor, routineActor, routinePrompt } from '../src/tools/routines.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';

const FAKE = fileURLToPath(new URL('./fake-routine-cli.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
const tmp = mkdtempSync(join(tmpdir(), 'unit7-routines-'));
Object.assign(process.env, {
  UNIT7_CLAUDE_BIN: FAKE, ROUTINE_CLI_RECORD: join(tmp, 'record.json'),
  OLLAMA_URL: 'http://127.0.0.1:9/v1', // no model connected
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const app = testApp();
const rows = (sql: string, ...p: string[]) => all<Record<string, any>>(app.db, sql, ...p).map((r) => ({ ...r }));
const errOf = (r: any) => (r.status === 'error' ? r.error : r.status === 'denied' ? { code: 'denied', message: r.why } : assert.fail(`expected a refusal, got ${JSON.stringify(r)}`));
const routineRow = (rid: string) => get<Record<string, any>>(app.db, 'SELECT * FROM routines WHERE id = ?', rid)!;

test('schedules in plain words', () => {
  const p = (s: string) => parseSchedule(s);
  assert.deepEqual(p('every Friday at 10:00'), { spec: { kind: 'days', days: [5], at: '10:00' }, label: 'Every Friday at 10:00' });
  assert.equal(p('every day').label, 'Every day at 09:00');
  assert.equal(p('daily at 7pm').label, 'Every day at 19:00');
  assert.equal(p('every weekday at 8am').label, 'Every weekday at 08:00');
  assert.equal(p('every monday and thursday at 7:30pm').label, 'Every Monday and Thursday at 19:30');
  assert.equal(p('mondays, wednesdays and fridays at noon').label, 'Every Monday, Wednesday and Friday at 12:00');
  assert.equal(p('every weekend at 10').label, 'Every Saturday and Sunday at 10:00');
  assert.equal(p('every morning').label, 'Every day at 09:00');
  assert.equal(p('every evening').label, 'Every day at 18:00');
  assert.equal(p('every friday morning').label, 'Every Friday at 09:00');
  assert.equal(p('every week').label, 'Every Monday at 09:00');
  assert.equal(p('every month on the 15th at 9:30').label, 'Every month on the 15th at 09:30');
  assert.equal(p('monthly').label, 'Every month on the 1st at 09:00');
  assert.deepEqual(p('every hour').spec, { kind: 'hours', every: 1 });
  assert.deepEqual(p('hourly').spec, { kind: 'hours', every: 1 });
  assert.equal(p('every 6 hours').label, 'Every 6 hours');
  assert.equal(p('every two hours').label, 'Every 2 hours');
  // never more often than hourly, and nothing Unit7 can't keep
  for (const s of ['every 15 minutes', 'every 30m', 'every minute', 'every half hour']) assert.throws(() => p(s), /at most once an hour/, s);
  assert.throws(() => p('every 40 hours'), /1 to 24 hours/);
  assert.throws(() => p('every month on the 31st'), /1 to 28/);
  assert.throws(() => p('daily at 25:00'), /isn’t a time/);
  assert.throws(() => p('every 3 hours on weekdays'), /not both/);
  assert.throws(() => p('whenever it feels right'), /didn’t understand/);
});

test('the next run is on the owner’s clock, across daylight saving', () => {
  const fri10 = parseSchedule('every friday at 10:00').spec;
  // Wednesday 7 Oct 2026: London is on summer time (UTC+1), so 10:00 there is 09:00 UTC
  assert.equal(nextRun(fri10, new Date('2026-10-07T12:00:00Z'), 'Europe/London').toISOString(), '2026-10-09T09:00:00.000Z');
  // after the clocks go back (25 Oct) it's 10:00 UTC
  assert.equal(nextRun(fri10, new Date('2026-10-28T12:00:00Z'), 'Europe/London').toISOString(), '2026-10-30T10:00:00.000Z');
  // on the Friday itself, after 10:00, it's next week
  assert.equal(nextRun(fri10, new Date('2026-10-09T09:00:00Z'), 'Europe/London').toISOString(), '2026-10-16T09:00:00.000Z');
  assert.equal(nextRun(parseSchedule('every day at 9').spec, new Date('2026-10-07T20:00:00Z'), 'America/New_York').toISOString(), '2026-10-08T13:00:00.000Z');
  // on the hour, where the hour is a half-hour off UTC
  assert.equal(nextRun(parseSchedule('every hour').spec, new Date('2026-10-07T10:10:00Z'), 'Asia/Kolkata').toISOString(), '2026-10-07T10:30:00.000Z');
  assert.equal(nextRun(parseSchedule('every 6 hours').spec, new Date('2026-10-07T13:20:00Z'), 'UTC').toISOString(), '2026-10-07T18:00:00.000Z');
  assert.equal(nextRun(parseSchedule('every month on the 1st at 08:00').spec, new Date('2026-10-07T00:00:00Z'), 'UTC').toISOString(), '2026-11-01T08:00:00.000Z');
  // a zone Unit7 doesn't know is UTC
  assert.equal(nextRun(fri10, new Date('2026-10-07T12:00:00Z'), 'Mars/Olympus').toISOString(), '2026-10-09T10:00:00.000Z');
});

test('a routine runs as its owner through the gate: an approval waits, then the run carries on', async () => {
  const o = await testOrg(app, 'Sam');
  const prj = ok(await o.h('project.create', { name: 'Old Thing' }));
  const r = ok(await o.h('routine.create', {
    name: 'Friday refresh', schedule: 'every friday at 10:00', tz: 'Europe/London', report: ['phone'],
    steps: [
      { tool: 'memory.remember', input: { content: 'The Friday refresh started' } },
      { tool: 'project.delete', input: { projectId: prj.projectId, confirm: 'old-thing' } }, // hard to undo: a person approves it
      { tool: 'memory.remember', input: { content: 'The Friday refresh finished' } },
    ],
  }));
  assert.equal(r.kind, 'steps');
  assert.equal(r.schedule, 'Every Friday at 10:00');
  const phone: string[] = [];
  const off = app.events.on((e) => { if (!e.live) phone.push(e.type); });

  const first = await runRoutine(app, r.routineId, 'now');
  assert.equal(first?.status, 'waiting');
  // step 1 ran as the routine, for Sam: an agent acting for its owner (so autonomy applies), not Sam's own click
  const audit = rows(`SELECT actor_kind, actor_name, user_id, tool, result FROM audit WHERE org_id = ? AND tool IN ('memory.remember', 'project.delete') ORDER BY created_at`, o.orgId);
  assert.deepEqual(audit.map((a) => [a.tool, a.actor_kind, a.user_id, a.result]), [['memory.remember', 'agent', o.userId, 'success'], ['project.delete', 'agent', o.userId, 'pending_approval']]);
  assert.equal(audit[0]!.actor_name, 'Routine “Friday refresh”');
  // step 2 waits on Approvals (the approval alert is what reaches the phone); step 3 hasn't run
  const apr = get<{ id: string; status: string; actor: string }>(app.db, `SELECT id, status, actor FROM approvals WHERE org_id = ? AND tool = 'project.delete'`, o.orgId)!;
  assert.equal(apr.status, 'pending');
  assert.equal(JSON.parse(apr.actor).name, 'Routine “Friday refresh”');
  assert.ok(phone.includes('approval.requested'));
  assert.equal(rows('SELECT 1 FROM memories WHERE org_id = ?', o.orgId).length, 1);
  assert.equal(routineRow(r.routineId).last_status, 'waiting');
  // the next scheduled time doesn't start a second run beside the waiting one
  run(app.db, 'UPDATE routines SET next_at = ? WHERE id = ?', '2026-01-01T00:00:00.000Z', r.routineId);
  await tick(app);
  assert.equal(rows('SELECT 1 FROM routine_runs WHERE routine_id = ?', r.routineId).length, 1);

  // Sam approves (typing the name, as for anything hard to undo); the next sweep carries the run on
  const d = await decideApproval(app, o.orgId, o.human, apr.id, true, 'Old Thing');
  assert.equal(d.status, 'ok');
  await runHeld(app, Date.now() + 49 * 3600_000); // a routine's delete waits 48 hours, even after a yes
  await tick(app);
  const runs = rows('SELECT status, summary, steps FROM routine_runs WHERE routine_id = ?', r.routineId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, 'ok');
  assert.deepEqual(JSON.parse(runs[0]!.steps).map((s: any) => s.status), ['ok', 'ok', 'ok']);
  assert.equal(rows('SELECT 1 FROM memories WHERE org_id = ?', o.orgId).length, 2);
  assert.equal(routineRow(r.routineId).last_status, 'ok');
  assert.ok(phone.includes('routine.report'), 'it said “tell me”, so the report goes to the phone too');
  off();

  // only its owner runs or changes it (it acts as them); an admin may pause it
  const other = { ...o.human, id: 'usr_someoneelse1', userId: 'usr_someoneelse1', name: 'Ada' };
  run(app.db, `INSERT INTO users (id, email, name) VALUES (?, 'ada@example.com', 'Ada')`, other.userId);
  run(app.db, `INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, 'admin')`, o.orgId, other.userId);
  assert.match(errOf(await o.as(other)('routine.run_now', { routineId: r.routineId })).message, /Only its owner/);
  assert.match(errOf(await o.as(other)('routine.update', { routineId: r.routineId, schedule: 'every day' })).message, /Only its owner/);
  ok(await o.as(other)('routine.pause', { routineId: r.routineId, paused: true }));
  assert.ok(routineRow(r.routineId).paused_at);
});

test('an AI’s routine waits for a person, and its ask is never passed off as theirs; Run now keeps the hourly floor', async () => {
  const o = await testOrg(app, 'Ola');
  // an AI saving (or changing, or turning back on) a routine asks a person first, whatever the autonomy
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  const asked = await o.a('routine.create', { name: 'Nightly wiring', schedule: 'every day', ask: 'wire the service key into every app and redeploy' }) as any;
  assert.equal(asked.status, 'approval_required');
  assert.equal(rows('SELECT 1 FROM routines WHERE org_id = ?', o.orgId).length, 0, 'nothing saved yet');
  const saved = await decideApproval(app, o.orgId, o.human, asked.approvalId, true);
  assert.equal(saved.status, 'ok');
  const rid = (saved as any).output.routineId;
  assert.equal(routineRow(rid).ask_by, 'ai');
  assert.equal(ok(await o.h('routine.list', { routineId: rid })).askBy, 'ai', 'shown as the AI’s, not the person’s');
  const prompt = routinePrompt(routineRow(rid) as any);
  assert.match(prompt, /written by an AI, not by the person/);
  assert.match(prompt, /<ai-suggested-task>\nwire the service key into every app and redeploy\n<\/ai-suggested-task>/);
  assert.equal((await o.a('routine.update', { routineId: rid, schedule: 'every hour' })).status, 'approval_required');
  ok(await o.a('routine.pause', { routineId: rid, paused: true }));
  assert.equal((await o.a('routine.pause', { routineId: rid, paused: false })).status, 'approval_required', 'turning it back on asks too');
  // the person’s own words are theirs
  const mine = ok(await o.h('routine.create', { name: 'Check', schedule: 'every day', ask: 'check that staging answers' }));
  assert.equal(ok(await o.h('routine.list', { routineId: mine.routineId })).askBy, 'person');
  const own = routinePrompt(routineRow(mine.routineId) as any);
  assert.ok(own.endsWith('check that staging answers') && !/written by an AI/.test(own));
  // an AI rewording the person’s ask makes it the AI’s again (once a person approves the change)
  const reword = await o.a('routine.update', { routineId: mine.routineId, ask: 'check staging and rotate every key' }) as any;
  assert.equal((await decideApproval(app, o.orgId, o.human, reword.approvalId, true)).status, 'ok');
  assert.equal(routineRow(mine.routineId).ask_by, 'ai');
  // Run now: at most hourly, like the schedule
  const steps = ok(await o.h('routine.create', { name: 'Note', schedule: 'every day', steps: [{ tool: 'memory.remember', input: { content: 'a note for later' } }] }));
  ok(await o.h('routine.run_now', { routineId: steps.routineId }));
  await new Promise((r) => setTimeout(r, 50));
  assert.match(errOf(await o.h('routine.run_now', { routineId: steps.routineId })).message, /at most once an hour/);
  run(app.db, 'UPDATE orgs SET autonomy = 3 WHERE id = ?', o.orgId);
});

test('what a routine can never do', async () => {
  const o = await testOrg(app, 'Kim');
  const make = (steps: unknown[], schedule = 'every day') => o.h('routine.create', { name: 'Bad', schedule, steps });
  // raise autonomy, change a budget, change routines (it could schedule itself), or anything only a person may do
  assert.match(errOf(await make([{ tool: 'autopilot.set', input: { paused: false } }])).message, /autonomy, budgets and Autopilot rules stay with people/);
  assert.match(errOf(await make([{ tool: 'budget.set', input: { monthly: 1000 } }])).message, /stay with people/);
  assert.match(errOf(await make([{ tool: 'routine.create', input: { name: 'x', schedule: 'every hour', ask: 'again' } }])).message, /can’t create or change routines/);
  assert.match(errOf(await make([{ tool: 'vault.set', input: { ref: 'credential://x/y/z', value: 'v' } }])).message, /Only a person/);
  assert.match(errOf(await make([{ tool: 'nothing.here', input: {} }])).message, /no action called/);
  // never more often than hourly
  assert.match(errOf(await make([{ tool: 'memory.remember', input: { content: 'hello there' } }], 'every 10 minutes')).message, /at most once an hour/);

  // a routine's run (or the AI answering one) can't make, change or run routines either
  const inside = o.as(routineActor({ name: 'Nightly', owner_id: o.userId }, 'owner'));
  assert.match(errOf(await inside('routine.create', { name: 'More', schedule: 'every hour', ask: 'do more' })).message, /can’t create or change routines/);
  // and an AI acting inside one can't touch autonomy (people only, whatever the step says)
  assert.equal((await inside('autopilot.set', { paused: false })).status, 'denied');

  // a refused step that got stored anyway is refused when it runs, and pauses the routine at once
  const good = ok(await make([{ tool: 'memory.remember', input: { content: 'hello there' } }]));
  run(app.db, 'UPDATE routines SET steps = ? WHERE id = ?', JSON.stringify([{ tool: 'environment.policy', input: {} }]), good.routineId);
  const res = await runRoutine(app, good.routineId, 'now');
  assert.equal(res?.status, 'refused');
  assert.match(routineRow(good.routineId).paused_why, /can’t be in a routine/);
});

test('three failed runs in a row pause it; a good run resets the count', async () => {
  const o = await testOrg(app, 'Lee');
  const prj = ok(await o.h('project.create', { name: 'Notes' }));
  const r = ok(await o.h('routine.create', { name: 'Note it', schedule: 'every hour', steps: [{ tool: 'memory.remember', input: { projectId: prj.projectId, content: 'checked in' } }] }));
  const alerts: string[] = [];
  const off = app.events.on((e) => { if (!e.live && e.type.startsWith('routine.')) alerts.push(e.type); });
  run(app.db, 'UPDATE projects SET org_id = (SELECT id FROM orgs WHERE id <> ? LIMIT 1) WHERE id = ?', o.orgId, prj.projectId); // the project went away
  for (let k = 1; k <= 2; k++) assert.equal((await runRoutine(app, r.routineId, 'now'))?.status, 'failed');
  assert.equal(routineRow(r.routineId).fails, 2);
  assert.equal(routineRow(r.routineId).paused_at, null);
  run(app.db, 'UPDATE projects SET org_id = ? WHERE id = ?', o.orgId, prj.projectId); // back
  assert.equal((await runRoutine(app, r.routineId, 'now'))?.status, 'ok');
  assert.equal(routineRow(r.routineId).fails, 0);
  run(app.db, 'UPDATE projects SET org_id = (SELECT id FROM orgs WHERE id <> ? LIMIT 1) WHERE id = ?', o.orgId, prj.projectId);
  for (let k = 1; k <= 3; k++) await runRoutine(app, r.routineId, 'now');
  const row = routineRow(r.routineId);
  assert.ok(row.paused_at, 'paused after the third failure');
  assert.match(row.paused_why, /3 failed runs in a row/);
  assert.equal(alerts.filter((t) => t === 'routine.failed').length, 5, 'every failed run alerts');
  assert.equal(alerts.filter((t) => t === 'routine.paused').length, 1);
  // paused: the sweep leaves it alone; resuming starts the count again
  run(app.db, 'UPDATE routines SET next_at = ? WHERE id = ?', '2026-01-01T00:00:00.000Z', r.routineId);
  const before = rows('SELECT 1 FROM routine_runs WHERE routine_id = ?', r.routineId).length;
  await tick(app);
  assert.equal(rows('SELECT 1 FROM routine_runs WHERE routine_id = ?', r.routineId).length, before);
  ok(await o.h('routine.pause', { routineId: r.routineId, paused: false }));
  assert.equal(routineRow(r.routineId).fails, 0);
  off();
});

test('the sweep runs what’s due, at most hourly', async () => {
  const o = await testOrg(app, 'Joe');
  const r = ok(await o.h('routine.create', { name: 'Hourly note', schedule: 'every hour', steps: [{ tool: 'memory.remember', input: { content: 'still here' } }] }));
  const count = () => rows('SELECT 1 FROM routine_runs WHERE routine_id = ?', r.routineId).length;
  await tick(app); // not due yet
  assert.equal(count(), 0);
  run(app.db, 'UPDATE routines SET next_at = ? WHERE id = ?', '2026-01-01T00:00:00.000Z', r.routineId);
  await tick(app);
  assert.equal(count(), 1);
  assert.ok(routineRow(r.routineId).next_at > new Date().toISOString(), 'the next run moved on');
  // even if the stored time says it's due again, never twice within the hour
  run(app.db, 'UPDATE routines SET next_at = ? WHERE id = ?', '2026-01-01T00:00:00.000Z', r.routineId);
  await tick(app);
  assert.equal(count(), 1);
});

test('save as a routine: the steps that worked in a conversation, without the looking around', async () => {
  const o = await testOrg(app, 'Max');
  const cnv = id('cnv');
  run(app.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', cnv, o.orgId, o.userId, 'update images on staging');
  const step = (tool: string, input: unknown, status = 'ok') => run(app.db, `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'tool', ?, ?)`,
    id('step'), cnv, JSON.stringify({ tool, input, status, output: {} }), new Date(Date.now() + Math.random()).toISOString());
  step('graph.get', {});                                         // looking around: left out
  step('memory.remember', { content: 'images updated on staging' });
  step('ui.choose', { title: 'Which app?' });                     // a question: left out
  step('memory.remember', { content: 'images updated on staging' }); // the same again: once
  step('project.create', { name: 'Never made' }, 'error');        // didn't work: left out
  step('autopilot.set', { paused: false });                       // can't be in a routine: left out, with why
  step('domain.check', { domainId: 'dom_aaaaaaaaaaaa' });         // a check: kept
  const preview = await o.h('routine.create', { name: 'Staging refresh', schedule: 'every friday at 10:00', conversationId: cnv }, { dryRun: true });
  assert.equal(preview.status, 'dry_run');
  const plan = (preview as any).plan;
  assert.deepEqual(plan.steps.map((s: any) => s.tool), ['memory.remember', 'domain.check']);
  assert.deepEqual(plan.skipped.map((s: any) => s.tool), ['autopilot.set']);
  assert.equal(plan.schedule, 'Every Friday at 10:00');
  assert.equal(rows('SELECT 1 FROM routines WHERE org_id = ?', o.orgId).length, 0, 'a preview saves nothing');
  const saved = ok(await o.h('routine.create', { name: 'Staging refresh', schedule: 'every friday at 10:00', conversationId: cnv }));
  assert.equal(saved.steps, 2);
  const listed = ok(await o.h('routine.list', { routineId: saved.routineId }));
  assert.equal(listed.kind, 'steps');
  assert.equal(listed.runsOn, 'No AI: saved steps');
  // someone else's conversation isn't yours to save
  const other = await testOrg(app, 'Zed');
  assert.equal(errOf(await other.h('routine.create', { name: 'Mine now', schedule: 'every day', conversationId: cnv })).code, 'not_found');
});

test('the brain rule: a schedule never runs on a personal subscription, only “Run now” by its owner does, and it says so when there is none', async () => {
  resetRateLimits();
  const o = await testOrg(app, 'Pat');
  // a teammate in the same workspace, whose own Claude subscription is turned on
  const mate = 'usr_teammate0001';
  run(app.db, `INSERT INTO users (id, email, name) VALUES (?, 'mate@example.com', 'Mate')`, mate);
  run(app.db, `INSERT INTO memberships (org_id, user_id, role, brain) VALUES (?, ?, 'developer', 'claude')`, o.orgId, mate);
  // Pat has no subscription and the workspace has no model: never the teammate's Claude
  assert.equal((await brainFor(app, o.orgId, o.userId)).kind, 'none');
  const mine = ok(await o.h('routine.create', { name: 'Check staging', schedule: 'every day', ask: 'Check that staging answers' }));
  const res = await runRoutine(app, mine.routineId, 'now');
  assert.equal(res?.status, 'failed');
  assert.match(res!.summary, /No API key or local model is connected/);
  assert.equal(rows(`SELECT 1 FROM conversations WHERE org_id = ? AND title LIKE 'Routine%'`, o.orgId).length, 0, 'nothing started');
  assert.equal(rows(`SELECT 1 FROM api_tokens WHERE user_id = ?`, mate).length, 0);

  // the teammate's own routine runs on the teammate's own Claude, as the teammate
  assert.equal((await brainFor(app, o.orgId, mate)).kind, 'none', 'nobody is watching a schedule, so no subscription');
  const b = await brainFor(app, o.orgId, mate, 'now');
  assert.deepEqual(b, { kind: 'subscription', cli: 'claude', label: 'Your Claude' });
  const http = createHttp(app);
  const server = await new Promise<ReturnType<typeof serve>>((r) => { const s = serve({ fetch: http.fetch, port: 0, hostname: '127.0.0.1' }, (info) => { app.services.listen = { host: '127.0.0.1', port: info.port }; r(s); }); });
  try {
    const theirs = ok(await o.as({ kind: 'user', id: mate, userId: mate, name: 'Mate', role: 'developer' })('routine.create', {
      name: 'Staging check', schedule: 'every weekday at 8am', ask: 'Check that staging answers', scope: [{ kind: 'server', id: 'srv_x', name: 'web-1' }] }));
    const done = await runRoutine(app, theirs.routineId, 'now');
    assert.equal(done?.status, 'ok', JSON.stringify(done));
    assert.equal(done!.summary, 'Checked staging: all good.');
    const rec = JSON.parse(readFileSync(process.env.ROUTINE_CLI_RECORD!, 'utf8'));
    assert.match(rec.stdin, /Check that staging answers/);
    assert.match(rec.stdin, /Nobody is watching/);
    assert.match(rec.stdin, /server web-1/);
    // inside the routine, its AI can't save another routine
    assert.equal(rec.tried.ok, false);
    assert.match(rec.tried.error, /can’t create or change routines/);
    const conv = get<{ user_id: string }>(app.db, 'SELECT user_id FROM conversations WHERE id = ?', done!.conversationId!)!;
    assert.equal(conv.user_id, mate, 'the run is the owner’s own conversation');
    assert.equal(rows(`SELECT 1 FROM api_tokens WHERE user_id = ?`, mate).length, 0, 'the run’s token is gone afterwards');
  } finally { server.close(); }
});
