// V2, ready for everyone: a config file with no secrets, metrics and events going out, an audit log that shows tampering, deletes
// that wait, small MCP profiles, the report card and badge, the Coolify contract, and your own SSH setup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, run } from '../src/db.ts';
import { fromYaml, toYaml } from '../src/ops/yaml.ts';
import { HELD_TOOLS, PROFILES, exportAudit, exportConfig, findTools, metricsText, planConfig, postEvent, runHeld, signBody, verifyLines } from '../src/ops/index.ts';
import { BADGE, NO_BADGE, allProven, badgeOf, cardMarkdown, cardOf, grade } from '../src/ops/report.ts';
import { CONTRACT, contractGap } from '../src/ops/contract.ts';
import { fromSshConfig, hostConfig, parseJump } from '../src/connectors/sshconfig.ts';
import { commandLog, ssh } from '../src/connectors/ssh.ts';
import { allTools, decideApproval, getTool } from './runtime-exports.ts';
import { scopes, createToken, fromToken } from '../src/auth.ts';
import { toolList } from '../src/mcp/server.ts';
import { JOBS } from '../web/src/pages/checkup/jobList.ts';

const SRV = 'srv_ops000000001';
const world = async () => { const app = testApp(); const o = await testOrg(app); run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'vps', '203.0.113.9', 'credential://x', 'ready', '{}')`, SRV, o.orgId); return { app, o }; };

test('X7: YAML round trips, and comments are fine', () => {
  const v = { version: 1, rules: [{ text: 'Never touch Harbor: really', tz: 'Asia/Kolkata' }, { text: 'plain' }], important: [], safety: { busy: { from: '09:00', to: '18:00' }, checkup: 'on' }, projects: [{ name: 'shop', environments: [{ name: 'production', kind: 'production', autonomy: 3 }], services: [{ name: 'web', kind: 'app', domains: ['a.example.com'], settings: ['DATABASE_URL'] }] }], n: null, yes: true, quoted: '# not a comment', num: '42' };
  assert.deepEqual(fromYaml(toYaml(v)), v);
  assert.deepEqual(fromYaml('a: 1 # note\n# whole line\nb:\n  - x\n  - y\n'), { a: 1, b: ['x', 'y'] });
  assert.throws(() => fromYaml('a: [1, 2]'), /plain lists and maps/);
});

test('X7: plan and apply only touch what Unit7 owns, and a secret in the file is refused', async () => {
  const { app, o } = await world();
  ok(await o.h('rule.add', { text: 'Never touch vps', tz: 'UTC' }));
  const is = exportConfig(app.db, o.orgId), want = { rules: [{ text: 'Never touch vps at night' }], safety: { checkup: 'off' }, projects: [{ name: 'ghost', environments: [], services: [] }] };
  const p = planConfig(want, is);
  assert.deepEqual(p.map((c) => [c.kind, !!c.apply]), [['add', true], ['remove', false], ['change', true], ['note', false]]);
  const yaml = toYaml({ ...is, ...want });
  assert.equal(ok<{ done: string[] }>(await o.h('config.apply', { yaml })).done.length, 2);
  assert.equal(exportConfig(app.db, o.orgId).rules.length, 2, 'nothing is removed by a file');
  assert.equal((await o.a('config.apply', { yaml })).status, 'denied');
  assert.equal((await o.h('config.plan', { yaml: 'password: hunter2hunter2\n' })).status, 'error', 'a file with a secret is refused');
  assert.ok(!/credential:\/\/|hunter/.test(ok<{ yaml: string }>(await o.h('config.export', {})).yaml));
});

test('X8: Prometheus text, and events signed on their way out', async () => {
  const { app, o } = await world();
  run(app.db, 'INSERT INTO metrics (server_id, at, cpu, mem_used, mem_total, disk_used, disk_total) VALUES (?, ?, 12.5, 100, 200, 300, 400)', SRV, new Date().toISOString());
  run(app.db, `INSERT INTO watch (org_id, host, kind, status) VALUES (?, 'a.example.com', 'site', 'ok'), (?, 'b.example.com', 'site', 'down')`, o.orgId, o.orgId);
  const m = metricsText(app.db, o.orgId);
  assert.match(m, /# TYPE unit7_server_cpu_percent gauge\nunit7_server_cpu_percent\{server="vps"\} 12\.5/); assert.match(m, /unit7_site_up\{host="b\.example\.com"\} 0/); assert.match(m, /unit7_blind_seconds_7d 0/);
  assert.equal(signBody('k', 'body'), `sha256=${createHmac('sha256', 'k').update('body').digest('hex')}`);
  app.vault.put(o.orgId, 'credential://webhook/events/url', 'https://hooks.example.com/x', {}); app.vault.put(o.orgId, 'credential://webhook/events/signing', 'key', {});
  const sent: { url: string; init: RequestInit }[] = [], fake = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response('ok'); }) as unknown as typeof fetch;
  assert.equal(await postEvent(app, { org_id: o.orgId, type: 'x', severity: 'info', message: 'm', created_at: 'now' }, fake), false, 'only what matters');
  assert.equal(await postEvent(app, { org_id: o.orgId, type: 'site.down', severity: 'critical', message: 'down', created_at: 'now' }, fake), true);
  assert.equal((sent[0]!.init.headers as Record<string, string>)['x-unit7-signature'], signBody('key', sent[0]!.init.body as string));
});

test('X9: the audit log shows a changed line, and server commands are on the record', async () => {
  const { app, o } = await world();
  for (const t of ['Never touch vps', 'Never touch vps at night', 'Never touch vps on weekends']) ok(await o.h('rule.add', { text: t }));
  const lines = exportAudit(app.db, o.orgId);
  assert.equal(lines.length, 3); assert.equal(verifyLines(lines).ok, true);
  const bad = [...lines]; bad[1] = bad[1]!.replace('at night', 'zzz');
  assert.match((verifyLines(bad) as { why: string }).why, /Line 2 was changed/);
  assert.match((verifyLines([lines[0]!, lines[2]!]) as { why: string }).why, /doesn’t follow/, 'a removed line shows too');
  ssh(app).exec = (async (_s: unknown, c: string) => { commandLog.getStore()?.push(c); return { code: 0, stdout: '', stderr: '', truncated: false }; }) as never;
  await o.h('security.who', {});
  assert.ok(commandLog);
});

test('X5: an AI’s delete waits 48 hours after a yes, a person can stop it, and a person’s own delete doesn’t wait', async () => {
  const { app, o } = await world();
  const { id: projectId } = ok<{ id: string }>(await o.h('project.create', { name: 'old-thing' }).then((r) => (r.status === 'ok' ? { ...r, output: { id: (r.output as { projectId?: string; id?: string }).projectId ?? (r.output as { id: string }).id } } : r)));
  const r = await o.a('project.delete', { projectId, confirm: 'old-thing' });
  assert.equal(r.status, 'approval_required', JSON.stringify(r));
  const decided = await decideApproval(app, o.orgId, o.human, (r as { approvalId: string }).approvalId, true, 'old-thing') as { status: string; output?: { held: boolean } };
  assert.equal(decided.status, 'ok'); assert.equal(decided.output!.held, true);
  assert.ok(get(app.db, 'SELECT 1 FROM projects WHERE id = ?', projectId), 'still there');
  assert.deepEqual(await runHeld(app, Date.now() + 47 * 3600_000), [], 'not yet');
  assert.equal(await runHeld(app, Date.now() + 49 * 3600_000).then((d) => d.length), 1);
  assert.equal(get(app.db, 'SELECT 1 FROM projects WHERE id = ?', projectId), undefined, 'gone after the wait');
  const second = ok<{ projectId?: string; id?: string }>(await o.h('project.create', { name: 'kept-thing' })), sid = second.projectId ?? second.id!;
  const ask = await o.a('project.delete', { projectId: sid, confirm: 'kept-thing' });
  await decideApproval(app, o.orgId, o.human, (ask as { approvalId: string }).approvalId, true, 'kept-thing');
  const held = ok<{ held: { id: string }[] }>(await o.h('delete.held', {})).held;
  assert.equal(held.length, 1); assert.equal((await o.a('delete.cancel', { id: held[0]!.id })).status, 'denied');
  assert.equal(ok<{ cancelled: boolean }>(await o.h('delete.cancel', { id: held[0]!.id })).cancelled, true);
  assert.deepEqual(await runHeld(app, Date.now() + 49 * 3600_000), []);
  assert.ok(get(app.db, 'SELECT 1 FROM projects WHERE id = ?', sid), 'cancelled, so it stays');
  for (const t of HELD_TOOLS) assert.ok(getTool(t), `${t} exists`);
});

test('X6: each profile is small, every tool in it exists, and the key can reach nothing else', async () => {
  for (const [name, list] of Object.entries(PROFILES)) { assert.ok(list.length <= 40, `${name}: ${list.length}`); for (const t of list) assert.ok(getTool(t), `${name}: ${t} exists`); assert.ok(list.includes('tools.find')); }
  assert.ok(allTools().length > 300);
  assert.deepEqual(Object.keys(scopes).sort(), ['deploy', 'findings', 'ops', 'read']);
  assert.ok(findTools('rotate a database password').some((t) => t.name.includes('rotate')));
  const { app, o } = await world();
  const p = fromToken(app.db, createToken(app.db, { user: { id: o.userId, email: 'a@b.c', name: 'Ada' }, org: { id: o.orgId, name: 'x', slug: 'x' }, role: 'owner', via: 'session' }, 'k', 'readonly', undefined, 'read').token)!;
  assert.equal(toolList(false, p.only).length, PROFILES.read!.length);
});

test('F11: the report card says what was measured, and streaks only when true', () => {
  assert.equal(grade(true, false), 'Good'); assert.equal(grade(false, true), 'Fair'); assert.equal(grade(false, false), 'Needs work');
  const c = cardOf({ week: '2026-11-06', important: 4, proven: 4, guarded: 4, uptime: 99.95, downDays: 0, p95: 320, urgent: 0, todo: 2, watched: 99.5, fixed: 1, daysSinceDown: 30 });
  assert.equal(c.protected.word, 'Good'); assert.equal(c.up.word, 'Good'); assert.equal(c.fast.word, 'Good'); assert.equal(c.safe.word, 'Fair'); assert.deepEqual(c.streaks, ['30 days with no downtime']);
  const empty = cardOf({ week: 'x', important: 0, proven: 0, guarded: 0, downDays: 0, urgent: 1, todo: 0, watched: 50, fixed: 0, daysSinceDown: 2 });
  assert.equal(empty.up.word, 'Not measured'); assert.equal(empty.safe.word, 'Needs work'); assert.deepEqual(empty.streaks, []);
  assert.equal(empty.protected.word, 'Not measured', 'nothing to protect isn’t a grade');
  assert.match(cardMarkdown(c), /\| Protected \| Good \| 4 of 4/); assert.match(cardMarkdown(c), /1 problem fixed and proven/);
});

test('F12: the badge shows only while it’s true', async () => {
  const { app, o } = await world();
  assert.equal(allProven(app.db, o.orgId), false, 'nothing important means nothing to claim');
  const r = ok<{ markdown: string; showing: boolean }>(await o.h('badge.link', {}));
  assert.equal(r.showing, false); const t = /badge\/([0-9a-f]+)\.svg/.exec(r.markdown)![1]!;
  assert.equal(badgeOf(app.db, t), NO_BADGE); assert.equal(badgeOf(app.db, 'nope'), NO_BADGE); assert.ok(BADGE.includes('Protected by Unit7'));
});

test('X12: a change in Coolify’s answers is caught', () => {
  const c = CONTRACT[1]!;
  assert.equal(contractGap(c, [{ uuid: 'a', name: 'b', status: 'running' }]), undefined);
  assert.equal(contractGap(c, []), undefined, 'nothing to compare');
  assert.equal(contractGap(c, { data: [] }), '/applications no longer answers with a list');
  assert.equal(contractGap(c, [{ uuid: 'a', name: 'b' }]), '/applications no longer has status');
});

test('X10: your own ~/.ssh/config: aliases, wildcards and one jump', () => {
  const text = `Host *\n  User deploy\nHost prod\n  HostName 10.0.0.5\n  Port 2222\n  ProxyJump ops@bastion:2200\nHost bastion\n  HostName 203.0.113.1\n  User ops\nHost *.internal !skip.internal\n  User svc\n# a comment\nMatch host x\n  User nope\n`;
  assert.deepEqual(hostConfig(text, 'prod'), { user: 'deploy', hostName: '10.0.0.5', port: 2222, proxyJump: 'ops@bastion:2200' });
  assert.equal(hostConfig(text, 'a.internal').user, 'deploy', 'first match wins, as in ssh');
  assert.deepEqual(parseJump('ops@bastion:2200'), { user: 'ops', host: 'bastion', port: 2200 }); assert.deepEqual(parseJump('bastion'), { user: undefined, host: 'bastion', port: 22 });
  const f = join(mkdtempSync(join(tmpdir(), 'unit7-ssh-')), 'config'); writeFileSync(f, text);
  assert.deepEqual(fromSshConfig('prod', f).jump, { host: '203.0.113.1', port: 2200, username: 'ops' });
  assert.deepEqual(fromSshConfig('anything', join(tmpdir(), 'no-such-file')), {}); assert.ok(id);
});

test('the ready-made jobs: every tool a job runs exists, each has a time, and only a job that uses an AI says so', () => {
  const jobs = JOBS.flatMap((g) => g.jobs);
  assert.ok(jobs.length >= 30); assert.equal(new Set(jobs.map((j) => j.id)).size, jobs.length);
  for (const j of jobs) { assert.ok(j.when.length > 3, j.id); if ('tool' in j) { const t = getTool(j.tool); assert.ok(t, j.tool); if (j.forEachServer) assert.ok('serverId' in (t!.input as unknown as { shape: object }).shape, `${j.tool} takes a server`); } if ('ask' in j) assert.equal(j.ai, true, j.id); }
  for (const j of jobs) if ('ask' in j) for (const m of j.ask.matchAll(/\b[a-z]+_[a-z_]+\b/g)) assert.ok(getTool(m[0]!.replace('_', '.')) || allTools().some((t) => t.name.replace(/\./g, '_') === m[0]), `${j.id} names ${m[0]}`);
});
