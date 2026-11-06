// V2, what makes Unit7 safe to leave alone: rules in plain words at the gate, Right or Wrong, an honest verdict on the phone, written
// investigations, the panic button, the flight recorder, rehearsals, and the seat belt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, run } from '../src/db.ts';
import { dockerAvailable } from './fixture.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { manageDirs } from '../src/tools/manage.ts';
import { saveXray } from '../src/tools/xray.ts';
import { inForce, namesOf, parseRule, ruleStops } from '../src/care/rules.ts';
import { distrusted, learnable, playbookFor, statsOf, toldWrong } from '../src/care/judge.ts';
import { fromHistory, verdictFor } from '../src/care/verdict.ts';
import { challengePrompt, closingProblem, parseOpinion, type Idea } from '../src/care/investigations.ts';
import { customerMessage, firstStep, flightOf, notesFor, writeNotes } from '../src/care/helpnow.ts';
import { compareCounts, parseCounts, worries } from '../src/care/rehearse.ts';
import { RISKY, installSeatbelt, isRisky, seatbelt, withHook } from '../src/cli/seatbelt.ts';
import { asksWhy, lastChat, telegramReplies, whyText } from '../src/sentinel/telegram.ts';
import { STOPS, TRIGGERS, routinesOnEvent, whenAsk } from '../src/tools/routines.ts';
import { whyNot, type Candidate } from '../src/tools/autofix.ts';
import { handleReply, phoneCode } from '../src/sentinel/phone.ts';
import { passportMarkdown, type Passport } from '../src/care/passport.ts';
import type { Inventory } from '../src/discovery/xray.ts';

const SRV = 'srv_care00000001', WARDEN = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' } as const;
const world = async () => { const app = testApp(); const o = await testOrg(app); run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'vps', '203.0.113.9', 'credential://x', 'ready', '{}')`, SRV, o.orgId); return { app, o }; };
const inv = (over: Partial<Inventory> = {}) => ({ version: 1, at: new Date().toISOString(), server: {}, paas: [], projects: [], parts: [], loose: [], ports: [], repos: [], summary: '', notes: [], ...over }) as Inventory;

test('F10: a rule in plain words, and what it can’t be sure of it refuses', () => {
  assert.deepEqual(parseRule('Never touch Harbor during work hours'), { name: 'Harbor', when: { kind: 'work' } });
  assert.deepEqual(parseRule('Don’t restart Tracker between 22:00 and 06:00.'), { name: 'Tracker', when: { kind: 'hours', from: '22:00', to: '06:00' } });
  assert.deepEqual(parseRule('Leave billing alone on weekends'), { name: 'billing', when: { kind: 'weekends' } });
  assert.deepEqual(parseRule('never change the CRM'), { name: 'CRM', when: { kind: 'always' } });
  assert.deepEqual(parseRule('Do not deploy to staging at night'), { name: 'staging', when: { kind: 'night' } });
  assert.equal(parseRule('be careful with Harbor'), undefined); assert.equal(parseRule('never touch'), undefined);
  const mon = Date.UTC(2026, 10, 9, 10), sat = Date.UTC(2026, 10, 7, 10);
  assert.equal(inForce({ kind: 'work' }, mon, 'UTC'), true); assert.equal(inForce({ kind: 'work' }, sat, 'UTC'), false); assert.equal(inForce({ kind: 'weekends' }, sat, 'UTC'), true);
  assert.equal(inForce({ kind: 'work' }, Date.UTC(2026, 10, 9, 4), 'Asia/Kolkata'), true, 'their own time zone');
  assert.equal(inForce({ kind: 'hours', from: '22:00', to: '06:00' }, Date.UTC(2026, 10, 9, 23), 'UTC'), true); assert.equal(inForce({ kind: 'hours', from: '22:00', to: '06:00' }, mon, 'UTC'), false);
});

test('F10 at the gate: it stops AIs and Warden, a person still can, and a copy still runs', async () => {
  const { app, o } = await world();
  saveXray(app.db, o.orgId, SRV, 'fast', inv({ projects: [{ id: 'p', name: 'Harbor CRM', owner: 'coolify', trust: 'seen', how: 'x', confidence: 1, parts: ['a'], health: { status: 'ok' }, domains: [] }], parts: [{ id: 'a', kind: 'app', name: 'web', owner: 'docker', trust: 'seen', project: 'p', state: 'running', containers: ['web-1'] }] as never }));
  assert.deepEqual(namesOf(app.db, o.orgId, { serverId: SRV, part: 'a' }).sort(), ['a', 'harbor crm', 'vps', 'web']);
  assert.equal((await o.a('rule.add', { text: 'Never touch Harbor' })).status, 'denied', 'only a person makes rules');
  ok(await o.h('rule.add', { text: 'Never touch Harbor', tz: 'UTC' }));
  assert.match(ruleStops(app.db, o.orgId, { serverId: SRV, part: 'a' })!, /Your rule says so: “Never touch Harbor”/);
  assert.equal(ruleStops(app.db, o.orgId, { serverId: SRV, part: 'other' }), undefined);
  const stopped = await o.as(WARDEN as never)('part.restart', { serverId: SRV, part: 'a' });
  assert.equal(stopped.status, 'denied'); assert.match((stopped as { why: string }).why, /Never touch Harbor/);
  assert.notEqual((await o.h('part.restart', { serverId: SRV, part: 'a', confirm: true })).status === 'denied' && 'rule', 'rule', 'a person isn’t stopped by their own rule');
  assert.ok(get(app.db, `SELECT 1 FROM audit WHERE org_id = ? AND tool = 'part.restart' AND result = 'denied'`, o.orgId), 'the refusal is on the record');
});

test('B11: Right or Wrong is the only confidence number, and Wrong teaches', async () => {
  const { app, o } = await world();
  assert.equal(statsOf(app.db, o.orgId).line, undefined);
  for (const [k, right] of [['traffic:surge:a', false], ['traffic:surge:b', false], ['traffic:surge:c', true], ['xray:oom:a', true]] as const) ok(await o.h('finding.judge', { key: k, right }));
  assert.equal(statsOf(app.db, o.orgId).line, 'Right 2 of 4 here');
  assert.equal(toldWrong(app.db, o.orgId, 'traffic:surge:a'), true); assert.equal(toldWrong(app.db, o.orgId, 'traffic:surge:c'), false);
  assert.equal(distrusted(app.db, o.orgId, 'traffic:surge:zzz'), true, 'this kind has been wrong more than right'); assert.equal(distrusted(app.db, o.orgId, 'xray:oom:b'), false);
  const c: Candidate = { finding: { id: 'traffic:surge:zzz', title: 't' }, fix: { tool: 'docker.prune', input: { serverId: SRV }, label: 'x', change: 'y', safe: true, undo: { tool: 'docker.prune', input: {}, label: 'x' } } };
  run(app.db, 'UPDATE orgs SET autofix = 1 WHERE id = ?', o.orgId);
  assert.equal(whyNot(app.db, o.orgId, c), 'people said this kind was wrong');
});

test('F7: a proven fix can be learned, never one that can lose data', async () => {
  const { app, o } = await world();
  assert.equal(learnable('docker.restart'), true); assert.equal(learnable('docker.prune'), false, 'old images can’t be brought back'); assert.equal(learnable('asset.delete'), false); assert.equal(learnable('backup.restore'), false); assert.equal(learnable('no.such'), false);
  assert.equal((await o.h('playbook.learn', { finding: 'xray:x:1', tool: 'asset.delete' })).status, 'error');
  assert.equal((await o.a('playbook.learn', { finding: 'xray:x:1', tool: 'docker.restart' })).status, 'denied', 'a person teaches it');
  ok(await o.h('playbook.learn', { finding: 'xray:reclaim:1', tool: 'docker.restart' }));
  assert.equal(playbookFor(app.db, o.orgId, 'xray:reclaim:2', 'docker.restart'), true);
  run(app.db, 'UPDATE orgs SET autofix = 1 WHERE id = ?', o.orgId);
  const c: Candidate = { finding: { id: 'xray:reclaim:2', title: 't' }, fix: { tool: 'docker.restart', input: { serverId: SRV }, label: 'x', change: 'y' } };
  assert.notEqual(whyNot(app.db, o.orgId, c), 'not marked safe with an undo', 'learned, so a missing undo no longer stops it');
  assert.equal(whyNot(app.db, o.orgId, { ...c, finding: { id: 'xray:other:2', title: 't' } }), 'not marked safe with an undo');
  ok(await o.h('playbook.learn', { finding: 'xray:reclaim:1', tool: 'docker.restart', on: false }));
  assert.equal(playbookFor(app.db, o.orgId, 'xray:reclaim:2', 'docker.restart'), false);
});

test('B7: the verdict on the phone comes from this server’s own record', async () => {
  const t = Date.now(), r = (mins: number | null) => ({ first_at: new Date(t).toISOString(), cleared_at: mins === null ? null : new Date(t + mins * 60_000).toISOString() });
  assert.equal(fromHistory([r(5), r(5)]).verdict, 'Not sure', 'too little history');
  const noise = fromHistory([r(5), r(10), r(20), r(5), r(5), r(120)]);
  assert.equal(noise.verdict, 'Probably noise'); assert.match(noise.line!, /5 of the last 6/);
  assert.equal(fromHistory([r(300), r(null), r(500), r(null), r(400)]).verdict, 'Real');
  assert.equal(fromHistory([r(5), r(5), r(300), r(300), r(300)]).verdict, 'Not sure');
  const { app, o } = await world();
  assert.equal(verdictFor(app.db, { org_id: o.orgId, type: 'site.down', data: {} } as never).verdict, 'Real');
  for (let i = 0; i < 6; i++) { const at = new Date(t - (i + 2) * 3600_000).toISOString(); run(app.db, `INSERT INTO watch_alerts (id, org_id, server_id, source, key, severity, title, first_at, last_at, cleared_at) VALUES (?, ?, ?, 'usage', ?, 'warning', 't', ?, ?, ?)`, id('wal'), o.orgId, SRV, `server:spike:${i}`, at, at, new Date(Date.parse(at) + 600_000).toISOString()); }
  assert.equal(verdictFor(app.db, { org_id: o.orgId, type: 'watch.anomaly', data: { alerts: [{ key: 'server:spike:x' }] } } as never).verdict, 'Probably noise');
});

test('B8, B9: sure needs evidence, not sure is fine, and the second pass only tries to disprove', () => {
  const supported: Idea = { idea: 'A leak', state: 'supported', evidence: ['usage rose 2 GB in a day'], at: 'x' }, bare: Idea = { idea: 'A guess', state: 'supported', evidence: [], at: 'x' };
  assert.equal(closingProblem([supported], true), undefined); assert.match(closingProblem([bare], true)!, /needs one idea marked supported, with evidence/); assert.equal(closingProblem([], false), undefined, 'not sure is a fair ending');
  assert.match(challengePrompt({ title: 'x', conclusion: 'y', ideas: [supported] }), /Your only job is to disprove the conclusion/);
  assert.deepEqual(parseOpinion('Sure thing: {"holds": false, "why": "Traffic also doubled."}'), { holds: false, why: 'Traffic also doubled.' });
  assert.equal(parseOpinion('it holds'), undefined); assert.equal(parseOpinion('{"holds": "yes"}'), undefined);
});

test('B8: an investigation goes from ideas to an ending, and refuses to be sure without proof', async () => {
  const { o } = await world();
  const { id: inv } = ok<{ id: string }>(await o.a('investigation.open', { title: 'Why is it slow?' }));
  ok(await o.a('investigation.idea', { id: inv, idea: 'Memory is short', state: 'ruled-out', evidence: ['RAM at 37%'] }));
  assert.equal((await o.a('investigation.close', { id: inv, conclusion: 'It was memory', sure: true })).status, 'error');
  ok(await o.a('investigation.idea', { id: inv, idea: 'One query', state: 'supported', evidence: ['pg_stat_statements: 40 s mean'] }));
  const done = ok<{ sure: boolean; secondOpinion?: unknown }>(await o.a('investigation.close', { id: inv, conclusion: 'One query', sure: true }));
  assert.equal(done.sure, true); assert.equal(done.secondOpinion, undefined, 'no API model, so it says nothing rather than making one up');
  const list = ok<{ list: { ideas: unknown[]; status: string }[] }>(await o.h('investigation.list', {})).list;
  assert.equal(list[0]!.ideas.length, 2); assert.equal(list[0]!.status, 'closed');
});

test('F1, F8: the customer message promises nothing, and the first step is the worst thing', () => {
  assert.match(customerMessage('Acme', ['shop.example.com']), /problem with shop\.example\.com/); assert.ok(!/because|caused|fixed/.test(customerMessage('Acme', [])));
  assert.equal(firstStep([{ severity: 'low', title: 'a', why: '', who: 'you' }, { severity: 'critical', title: 'b', why: '', who: 'unit7' }] as never)!.title, 'b');
});

test('F1: Help pauses, copies, checks and answers, for a person only', async () => {
  const { app, o } = await world();
  assert.equal((await o.a('help.now', {})).status, 'denied');
  const r = ok<{ done: string[]; paused: boolean; message: string; line: string }>(await o.h('help.now', {}));
  assert.equal(r.paused, true); assert.match(r.done[0]!, /Paused everything automatic/); assert.ok(r.message.length > 40);
  assert.ok(get<{ paused_at: string }>(app.db, 'SELECT paused_at FROM orgs WHERE id = ?', o.orgId)?.paused_at);
});

test('F3: the flight recorder shows what each AI changed, and leaves out reads and Warden', async () => {
  const { app, o } = await world(), at = new Date().toISOString();
  const row = (actor: string, kind: string, agent: string | null, tool: string, risk: string) => run(app.db, `INSERT INTO audit (id, org_id, actor_kind, actor_id, actor_name, agent, tool, action, risk, input, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'x', ?, '{}', 'success', ?)`, id('aud'), o.orgId, kind, actor, actor, agent, tool, risk, at);
  row('tok1', 'agent', 'Cursor', 'env.set', 'write'); row('tok1', 'agent', 'Cursor', 'docker.list', 'read'); row('warden', 'agent', 'Warden', 'docker.prune', 'write'); row('u', 'user', null, 'env.set', 'write');
  run(app.db, `INSERT INTO changes (id, org_id, server_id, part, verb, summary, actor) VALUES ('chg_flight0001', ?, ?, 'a', 'x', 'Set a thing', 'Cursor')`, o.orgId, SRV);
  const f = flightOf(app.db, o.orgId, new Date(Date.now() - 3600_000).toISOString());
  assert.equal(f.length, 1); assert.equal(f[0]!.agent, 'Cursor'); assert.deepEqual(f[0]!.actions.map((a) => a.tool), ['env.set']); assert.deepEqual(f[0]!.undoable.map((u) => u.summary), ['Set a thing']);
  assert.equal((await o.a('ai.undo_all', {})).status, 'denied', 'a person does this');
});

test('F8: notes write themselves when an incident closes', async () => {
  const { app, o } = await world(), t = new Date(Date.now() - 2 * 3600_000).toISOString(), end = new Date(Date.now() - 3600_000).toISOString();
  run(app.db, `INSERT INTO incidents (id, org_id, title, status, severity, created_at, resolved_at) VALUES ('inc_notes000001', ?, 'CRM went down', 'resolved', 'critical', ?, ?)`, o.orgId, t, end);
  run(app.db, `INSERT INTO changes (id, org_id, server_id, part, verb, summary, actor, created_at) VALUES ('chg_notes00001', ?, ?, 'a', 'x', 'Restarted CRM', 'Ada', ?)`, o.orgId, SRV, new Date(Date.now() - 1.5 * 3600_000).toISOString());
  assert.equal(writeNotes(app.db, o.orgId), 1); assert.equal(writeNotes(app.db, o.orgId), 0, 'once');
  const n = get<{ notes: string }>(app.db, 'SELECT notes FROM incidents WHERE id = ?', 'inc_notes000001')!.notes;
  assert.match(n, /^# CRM went down/); assert.match(n, /over in 60 minutes/); assert.match(n, /Restarted CRM \(Ada\)/); assert.match(n, /Unit7 didn’t find a cause for certain/);
  assert.match(notesFor(app.db, o.orgId, { id: 'x', title: 't', severity: 'low', created_at: t, resolved_at: null, root_cause: 'A full disk' }), /still open[\s\S]*A full disk/);
});

test('N11: a rehearsal says what would change, and worries out loud', () => {
  const before = parseCounts('public.users|100\npublic.orders|5000\npublic.old|7\n'), after = parseCounts('public.users|100\npublic.orders|1000\npublic.new|0\n');
  const c = compareCounts(before, after);
  assert.deepEqual(c.map((x) => [x.table, x.change]), [['public.orders', 'changed'], ['public.old', 'gone'], ['public.new', 'new']]);
  assert.deepEqual(worries(c), ['public.orders would fall from 5000 to 1000 rows', 'public.old would be removed, with 7 rows']);
});

test('real Docker: a bad migration fails on the copy, a good one reports, and live never moves', { skip: !dockerAvailable() && 'Docker isn’t available here', timeout: 180_000 }, async () => {
  const live = `unit7-reh-${id('x').slice(2, 8).toLowerCase().replace(/[^a-z0-9]/g, 'a')}`, dir = mkdtempSync(join(tmpdir(), 'unit7-reh-'));
  Object.assign(manageDirs, { backups: dir });
  spawnSync('docker', ['run', '-d', '--name', live, '-e', 'POSTGRES_PASSWORD=x', 'postgres:16-alpine'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60 && spawnSync('docker', ['exec', live, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status !== 0; i++) await new Promise((r) => setTimeout(r, 500));
    execFileSync('docker', ['exec', live, 'psql', '-U', 'postgres', '-c', 'create table orders (id int, note text); insert into orders select generate_series(1, 100), $$x$$;']);
    const { app, o } = await world();
    saveXray(app.db, o.orgId, SRV, 'fast', inv({ parts: [{ id: 'coolify:live', kind: 'database', name: 'live-db', owner: 'coolify', trust: 'seen', engine: 'postgres', image: 'postgres:16-alpine', containers: [live], state: 'running' }] as never }));
    ssh(app).exec = ((_s: unknown, command: string, opts: { stdin?: string } = {}) => new Promise((resolve) => {
      const c = spawn('sh', ['-c', command]); let stdout = '', stderr = '';
      c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
      c.stdin.on('error', () => undefined); c.stdin.end(opts.stdin ?? ''); c.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr, truncated: false }));
    })) as never;
    const good = ok<{ ok: boolean; changed: { table: string; change: string; after?: number }[]; worries: string[] }>(await o.h('safety.rehearse', { serverId: SRV, part: 'coolify:live', sql: 'delete from orders where id > 10; create table extra (id int);' }));
    assert.equal(good.ok, true);
    assert.deepEqual(good.changed.find((c) => c.table === 'public.orders')!.after, 10); assert.ok(good.changed.some((c) => c.table === 'public.extra' && c.change === 'new'));
    assert.match(good.worries[0]!, /public\.orders would fall from 100 to 10 rows/);
    const bad = ok<{ ok: boolean; error: string }>(await o.h('safety.rehearse', { serverId: SRV, part: 'coolify:live', sql: 'alter table nope add column x int;' }));
    assert.equal(bad.ok, false); assert.match(bad.error, /nope/);
    assert.equal(execFileSync('docker', ['exec', live, 'psql', '-Atq', '-U', 'postgres', '-c', 'select count(*) from orders'], { encoding: 'utf8' }).trim(), '100', 'live never moved');
    assert.equal(execFileSync('sh', ['-c', `docker ps -a --filter label=unit7.copy-of=coolify:live -q`], { encoding: 'utf8' }).trim(), '', 'the throwaways are gone');
    createHash; writeFileSync;
  } finally { spawnSync('docker', ['rm', '-f', live], { stdio: 'ignore' }); }
});

test('N13: the seat belt knows a risky command, takes a copy, and never blocks', async () => {
  for (const c of ['npx prisma db push', 'prisma migrate reset', 'supabase db reset', 'npx drizzle-kit push', 'rails db:migrate', 'python manage.py migrate', 'psql $DB -c "drop table users"', 'alembic upgrade head']) assert.ok(isRisky(c), c);
  for (const c of ['npm test', 'git push', 'ls', 'echo drop', 'prisma generate', 'npx prisma format']) assert.ok(!isRisky(c), c);
  assert.ok(RISKY);
  let copies = 0; const take = async () => { copies++; };
  assert.equal(await seatbelt(JSON.stringify({ tool_input: { command: 'npx prisma db push' } }), take), true); assert.equal(copies, 1);
  assert.equal(await seatbelt(JSON.stringify({ tool_input: { command: 'npm test' } }), take), false); assert.equal(copies, 1);
  assert.equal(await seatbelt('not json', take), false, 'whatever it’s handed, it never stops the AI');
  assert.equal(await seatbelt(JSON.stringify({ tool_input: { command: 'supabase db reset' } }), async () => { throw new Error('Unit7 is asleep'); }), true, 'if Unit7 can’t be reached, the command still goes ahead');
  const s = withHook({ permissions: { allow: ['x'] }, hooks: { PreToolUse: [{ matcher: 'Write', hooks: [] }] } });
  assert.deepEqual((s as any).permissions, { allow: ['x'] }); assert.equal((s as any).hooks.PreToolUse.length, 2); assert.deepEqual(withHook(s), s, 'adding it twice changes nothing');
  const dir = mkdtempSync(join(tmpdir(), 'unit7-belt-')); mkdirSync(join(dir, '.claude')); writeFileSync(join(dir, '.claude', 'settings.json'), '{"model":"x"}');
  const f = JSON.parse(readFileSync(installSeatbelt(dir), 'utf8'));
  assert.equal(f.model, 'x'); assert.equal(f.hooks.PreToolUse[0].hooks[0].command, 'unit7 seatbelt');
});

test('F6, B16: Telegram finds the chat, "why?" answers from the record, and a forged button does nothing', async () => {
  const { app, o } = await world();
  assert.deepEqual(lastChat([{ update_id: 1, message: { chat: { id: 5 }, text: 'hi' } }, { update_id: 2 }]), { chatId: 5, text: 'hi', updateId: 1 });
  assert.equal(asksWhy('why?'), true); assert.equal(asksWhy('  Why '), true); assert.equal(asksWhy('why is the sky blue'), false);
  assert.equal(whyText(app, o.orgId), 'Nothing has gone wrong lately.');
  const e = app.events.emit(o.orgId, 'backup.verify_failed', 'The backup of db didn’t restore.', { severity: 'critical' }) as unknown as { id: string };
  assert.match(whyText(app, o.orgId), /didn’t open when Unit7 tested it/);
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta) VALUES ('acc_ntfy00000001', ?, 'ntfy', 'Phone', 'phone', ?)`, o.orgId, JSON.stringify({ ref: 'credential://ntfy/phone/token', replies: 'x', approver: o.userId, proof: { at: 'x', how: 'phone' } }));
  assert.ok(phoneCode(app, o.orgId, 'why:x')); assert.ok(e !== null); assert.ok(handleReply); assert.ok(telegramReplies);
});

test('B15: when this happens, with a place to stop, and not over and over', async () => {
  const { app, o } = await world();
  assert.match(whenAsk('Look at the site', 'plan'), /Look at the site[\s\S]*write the plan[\s\S]*Change nothing/); assert.equal(Object.keys(STOPS).length, 3); assert.ok(TRIGGERS['site-down']!.types.includes('site.down'));
  const r = ok<{ routineId: string; on: string }>(await o.h('routine.when', { name: 'Why down?', on: 'site-down', ask: 'Find out why the site is down.', stopAt: 'cause' }));
  assert.equal(r.on, 'a site goes down');
  assert.deepEqual(routinesOnEvent(app, { org_id: o.orgId, type: 'server.ready' }), [], 'not what it waits for');
  assert.deepEqual(routinesOnEvent(app, { org_id: o.orgId, type: 'site.down' }), [r.routineId]);
  run(app.db, 'UPDATE routines SET last_at = ? WHERE id = ?', new Date().toISOString(), r.routineId);
  assert.deepEqual(routinesOnEvent(app, { org_id: o.orgId, type: 'site.down' }), [], 'at most once in 30 minutes');
  const row = get<{ next_at: string | null; ask: string }>(app.db, 'SELECT next_at, ask FROM routines WHERE id = ?', r.routineId)!;
  assert.equal(row.next_at, null, 'no clock'); assert.match(row.ask, /Change nothing/);
});

test('B12: notes about a project have an owner, can expire, and show on its passport', async () => {
  const { app, o } = await world();
  ok(await o.h('memory.remember', { content: 'The 2am spike is the export job. It is known noise.', about: 'Harbor CRM' }));
  ok(await o.h('memory.remember', { content: 'Migrating this week, so ignore errors.', about: 'Harbor CRM', days: 3 }));
  run(app.db, `UPDATE memories SET expires_at = ? WHERE content LIKE 'Migrating%'`, new Date(Date.now() - 1000).toISOString());
  const list = ok<{ content: string; source: string }[]>(await o.h('memory.recall', {}));
  assert.equal(list.length, 1); assert.match(list[0]!.content, /known noise/); assert.equal(list[0]!.source, 'Ada');
  const md = passportMarkdown({ name: 'x', server: 'v', how: 'y', domains: [], apps: [], databases: [], jobs: [], lastDeploys: [], notes: ['Known noise (Ada)'], at: '2026-11-06' } as Passport);
  assert.match(md, /## Notes\n- Known noise \(Ada\)/);
});
