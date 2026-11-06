// Background work that must stay right over weeks of running: servers that come back, backups that fail,
// sign-ins refreshed once, keys retired only when safe, alerts that really went out, and nothing piling up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, get, id, now, run } from '../src/db.ts';
import { Warden } from '../src/sentinel/warden.ts';
import { accessToken, type OAuthSecret } from '../src/connectors/mcp-oauth.ts';
import { StdioMcp } from '../src/connectors/mcp-stdio.ts';
import { earnedCheck } from '../src/tools/autopilot.ts';
import { forecast } from '../src/tools/budget.ts';
import { SINKS, thingsFrom, suggest } from '../src/tools/links.ts';
import { nameMissing } from '../src/tools/map.ts';
import { decide } from '../src/sentinel/autoscale.ts';
import { deliver } from '../src/sentinel/notify.ts';
import { checkDaily } from '../src/sentinel/watch.ts';
import { enqueue } from '../src/agent/bridge.ts';
import { isRunning } from '../src/agent/conversations.ts';
import { setupNtfy } from '../src/connectors/oneclick.ts';
import { Unit7Error } from '../src/errors.ts';

type App = ReturnType<typeof testApp>;
const events = (app: App, type: string) => all<{ message: string }>(app.db, 'SELECT message FROM events WHERE type = ?', type).map((e) => e.message);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test('a server Warden marked unreachable is still watched, and comes back as ready', async () => {
  const app = testApp(); const o = await testOrg(app);
  let up = false;
  app.services.ssh = {
    check: async () => { if (!up) throw new Error('connect ETIMEDOUT'); return ''; },
    exec: async () => ({ code: 1, stdout: '', stderr: '' }),
  };
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready')`, srv, o.orgId);
  const w = new Warden(app);
  for (let i = 0; i < 4; i++) await w.checkNow();
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM servers WHERE id = ?', srv)!.status, 'unreachable');
  assert.equal(events(app, 'server.unreachable').length, 1, 'said once, not every ten minutes');
  up = true;
  await w.checkNow();
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM servers WHERE id = ?', srv)!.status, 'ready');
  assert.match(events(app, 'server.recovered')[0]!, /box is answering Unit7 again/);
  // a server that never connected (or that a person must fix) is not Warden's to revive
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'new', '203.0.113.10', 'credential://ssh/new/private-key', 'unreachable')`, id('srv'), o.orgId);
  await w.checkNow();
  assert.equal(get<{ n: number }>(app.db, `SELECT count(*) n FROM servers WHERE status = 'ready'`)!.n, 1);
});

test('a scheduled backup that fails says so once, keeps its schedule due, and is retried later', async () => {
  const app = testApp(); const o = await testOrg(app);
  const env = ok(await o.h('project.create', { name: 'B', environments: ['production'] })).environments[0].id;
  const svc = ok(await o.h('service.create', { environmentId: env, name: 'db', source: { type: 'git', repo: 'ada/x' } })).serviceId;
  const sch = id('bks');
  run(app.db, `INSERT INTO backup_schedules (id, org_id, service_id, frequency, keep) VALUES (?, ?, ?, 'daily', 7)`, sch, o.orgId, svc);
  const w = new Warden(app);
  await w.sweepNow();
  await w.sweepNow();
  assert.equal(events(app, 'backup.failed').length, 1);
  assert.match(events(app, 'backup.failed')[0]!, /daily backup of db failed/);
  assert.equal(get<{ last_run_at: string | null }>(app.db, 'SELECT last_run_at FROM backup_schedules WHERE id = ?', sch)!.last_run_at, null, 'still due');
  assert.equal(all(app.db, `SELECT 1 FROM audit WHERE tool = 'backup.create'`).length, 1, 'not hammered every minute');
});

test('a sign-in is refreshed once for many callers, and Warden can refresh it early', async () => {
  let calls = 0;
  const srv = createServer((req, res) => {
    calls++;
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: `at-${calls}`, refresh_token: `rt-${calls}`, expires_in: 3600 })); }, 50);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const endpoint = `http://127.0.0.1:${(srv.address() as { port: number }).port}/token`;
    let blob: OAuthSecret = { access_token: 'old', refresh_token: 'rt-0', expires_at: Date.now() + 30_000, client_id: 'c', token_endpoint: endpoint, mcp_url: 'x', resource: 'x' };
    const read = () => JSON.stringify(blob), store = (s: OAuthSecret) => { blob = s; };
    const got = await Promise.all([1, 2, 3].map(() => accessToken('org:ref', read, store)));
    assert.deepEqual(got, ['at-1', 'at-1', 'at-1']);
    assert.equal(calls, 1, 'one refresh: a rotating refresh token is never spent twice');
    blob = { ...blob, expires_at: Date.now() + 4 * 60_000 };
    assert.equal(await accessToken('org:ref', read, store), 'at-1', 'four minutes left is fine for a call');
    assert.equal(await accessToken('org:ref', read, store, 5 * 60_000), 'at-2', 'Warden refreshes five minutes early');
  } finally { srv.close(); }
});

test('the old key is retired only once the client has the new one, and a half-failed sync is resumed, not redone', async () => {
  const app = testApp(); const o = await testOrg(app);
  const env = ok(await o.h('project.create', { name: 'Biz', environments: ['production'] })).environments[0].id;
  const crm = ok(await o.h('service.create', { environmentId: env, name: 'crm', source: { type: 'git', repo: 'ada/crm' } })).serviceId;
  const web = ok(await o.h('service.create', { environmentId: env, name: 'web', source: { type: 'git', repo: 'ada/web' } })).serviceId;
  run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status) VALUES (?, ?, 'crm.shop.test', ?, 'active')`, id('dom'), o.orgId, crm);
  const linkId = ok(await o.a('link.create', { from: { kind: 'unit7', serviceId: crm }, to: { kind: 'unit7', serviceId: web } })).linkId as string;
  const sink = SINKS.unit7!, { set, current } = sink;
  // an API side that can't be read back (like Fly secrets), and a client side that refuses for now
  sink.current = async () => ({});
  sink.set = async (ctx, e, vars) => { if ((e as { serviceId: string }).serviceId === web) throw new Unit7Error('unavailable', 'client side unavailable', 502); return set(ctx, e, vars); };
  const apiSets = () => all(app.db, `SELECT 1 FROM audit WHERE tool = 'env.set' AND reason = 'link' AND input LIKE '%"WEB_API_KEY"%'`).length;
  try {
    assert.equal((await o.a('link.rotate', { linkId })).status, 'error');
    const after = apiSets();
    assert.equal((await o.a('link.sync', { linkId })).status, 'error');
    assert.equal(apiSets(), after, 'the API side already has the new key: not set (and redeployed) again');
    // the grace day is over, but the client still has the old key: the old key keeps working
    run(app.db, 'UPDATE links SET previous_until = ? WHERE id = ?', ago(1000), linkId);
    const r = ok(await o.a('link.retire_previous', { linkId }));
    assert.equal(r.retired, false);
    assert.ok(get<{ previous_until: string }>(app.db, 'SELECT previous_until FROM links WHERE id = ?', linkId)!.previous_until > now(), 'grace extended');
  } finally { sink.set = set; sink.current = current; }
  ok(await o.a('link.sync', { linkId }));
  const r = ok(await o.a('link.retire_previous', { linkId }));
  assert.equal(r.retired, true);
  assert.equal(get<{ previous_until: string | null }>(app.db, 'SELECT previous_until FROM links WHERE id = ?', linkId)!.previous_until, null);
});

test('one incident lowers earned autonomy one level, not one level per hourly check', async () => {
  const app = testApp(); const o = await testOrg(app);
  const envId = ok(await o.h('project.create', { name: 'shop', environments: ['production'] })).environments[0].id;
  run(app.db, 'UPDATE environments SET earn = 1, autonomy = 3, earn_changed_at = ? WHERE id = ?', ago(10 * 86400_000), envId);
  for (let i = 0; i < 3; i++) run(app.db, `INSERT INTO audit (id, org_id, actor_kind, actor_id, actor_name, environment_id, tool, action, risk, result, created_at) VALUES (?, ?, 'agent', 'warden', 'Warden', ?, 'service.sync_git', 'deploy', 'write', 'error', ?)`, id('aud'), o.orgId, envId, ago(60_000));
  assert.equal(earnedCheck(app, envId)!.to, 2);
  assert.equal(earnedCheck(app, envId)!.to, 2);
  assert.equal(earnedCheck(app, envId)!.to, 2);
});

test('an MCP server that failed its handshake is started fresh next time; one killed by a signal fails its calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-mcp-'));
  const marker = join(dir, 'started-once');
  // slow only the very first time it ever starts (like npx downloading on first use)
  const server = `const fs=require('fs');const slow=!fs.existsSync(${JSON.stringify(marker)});fs.writeFileSync(${JSON.stringify(marker)},'1');
process.stdin.on('data',d=>{for(const l of String(d).split('\\n').filter(Boolean)){const m=JSON.parse(l);if(m.id==null)continue;
if(m.method==='tools/call'&&m.params.name==='hang')continue;
setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='tools/list'?{tools:[{name:'x'}]}:{}})+'\\n'),slow?1500:0)}});`;
  writeFileSync(join(dir, 's.js'), server);
  const c = new StdioMcp({ command: process.execPath, args: [join(dir, 's.js')], readyTimeoutMs: 500 });
  await assert.rejects(c.listTools(), /did not answer initialize/);
  assert.deepEqual(await c.listTools(), [{ name: 'x' }], 'the second call starts over instead of reusing the failed handshake');
  const hanging = c.callTool('hang', {}, 60_000);
  await new Promise((r) => setTimeout(r, 100));
  (c as unknown as { child: { kill(s: string): void } }).child.kill('SIGKILL');
  await assert.rejects(hanging, /exited \(SIGKILL\)/);
  assert.deepEqual(await c.listTools(), [{ name: 'x' }]);
  c.close();
});

test('Warden keeps a month of machine reads and three months of events; no-op git checks go after an hour', async () => {
  const app = testApp(); const o = await testOrg(app);
  const audit = (actor: string, risk: string, at: string, tool = 'server.metrics', result = 'success', output: string | null = null) =>
    run(app.db, `INSERT INTO audit (id, org_id, actor_kind, actor_id, actor_name, tool, action, risk, result, output, created_at) VALUES (?, ?, ?, 'x', 'x', ?, 'read', ?, ?, ?, ?)`, id('aud'), o.orgId, actor, tool, risk, result, output, at);
  audit('agent', 'read', ago(40 * 86400_000));
  audit('agent', 'read', ago(40 * 86400_000), 'server.metrics', 'denied');
  audit('agent', 'write', ago(40 * 86400_000));
  audit('user', 'read', ago(40 * 86400_000));
  audit('agent', 'read', ago(86400_000));
  run(app.db, `INSERT INTO audit (id, org_id, actor_kind, actor_id, actor_name, tool, action, risk, result, output, created_at) VALUES ('aud_noop', ?, 'agent', 'warden', 'Warden', 'service.sync_git', 'deploy', 'write', 'success', '{"deployed":false,"sha":"abc"}', ?)`, o.orgId, ago(2 * 3600_000));
  run(app.db, `INSERT INTO events (id, org_id, type, severity, message, data, created_at) VALUES (?, ?, 'action.completed', 'success', 'x', '{"tool":"service.sync_git","auditId":"aud_noop"}', ?)`, id('evt'), o.orgId, ago(2 * 3600_000));
  run(app.db, `INSERT INTO events (id, org_id, type, severity, message, created_at) VALUES (?, ?, 'site.down', 'critical', 'old', ?)`, id('evt'), o.orgId, ago(100 * 86400_000));
  run(app.db, `INSERT INTO events (id, org_id, type, severity, message, created_at) VALUES (?, ?, 'site.down', 'critical', 'recent', ?)`, id('evt'), o.orgId, ago(10 * 86400_000));
  (new Warden(app) as unknown as { trimHistory(): void }).trimHistory();
  assert.equal(all(app.db, 'SELECT 1 FROM audit').length, 4, 'kept: the refusal, the change, the person, the recent read');
  assert.deepEqual(all<{ message: string }>(app.db, 'SELECT message FROM events').map((e) => e.message), ['recent']);
});

test('over budget: autoscale is capped, and gets its maximum back once spending is under budget', async () => {
  const app = testApp(); const o = await testOrg(app);
  const env = ok(await o.h('project.create', { name: 'S', environments: ['production'] })).environments[0].id;
  const svc = ok(await o.h('service.create', { environmentId: env, name: 'web', source: { type: 'git', repo: 'ada/web' } })).serviceId;
  run(app.db, `UPDATE services SET config = json_set(config, '$.replicas', 1, '$.autoscale', json('{"on":true,"min":1,"max":4}')) WHERE id = ?`, svc);
  const max = () => get<{ max: number }>(app.db, `SELECT json_extract(config, '$.autoscale.max') max FROM services WHERE id = ?`, svc)!.max;
  ok(await o.h('budget.set', { monthly: 1, currency: 'USD', manual: [{ label: 'Big plan', monthly: 1_000_000 }], scaleDown: true }));
  assert.equal(ok(await o.a('budget.check', {})).level, 'over');
  assert.equal(max(), 1);
  ok(await o.a('budget.check', {}));
  assert.equal(max(), 1, 'still over: still capped');
  ok(await o.h('budget.set', { monthly: 10_000_000 }));
  ok(await o.a('budget.check', {}));
  assert.equal(max(), 4, 'the maximum a person set is back');
});

test('billing-period usage is counted as it stands, not projected over the calendar month', () => {
  const day11 = new Date(Date.UTC(2026, 10, 11)); // a third of November gone
  const f = forecast([{ amount: 50, kind: 'spent' }, { amount: 30, kind: 'period' }], day11);
  assert.equal(Math.round(f.forecast), 180, '50 this month → 150, plus the 30 of the billing period as it is');
  assert.equal(Math.round(f.soFar), 80);
});

test('a domain is "gone" only when DNS says so for every kind of record', async () => {
  const err = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
  const dns = (a: () => Promise<unknown[]>, aaaa: () => Promise<unknown[]>, cname: () => Promise<unknown[]>) => ({ resolve4: a, resolve6: aaaa, resolveCname: cname });
  assert.equal(await nameMissing('x', dns(() => err('ENOTFOUND'), () => err('ENOTFOUND'), () => err('ENOTFOUND'))), true);
  assert.equal(await nameMissing('x', dns(() => err('ENODATA'), async () => ['2001:db8::1'], () => err('ENODATA'))), false, 'IPv6 only still exists');
  assert.equal(await nameMissing('x', dns(() => err('ETIMEOUT'), () => err('ENOTFOUND'), () => err('ENOTFOUND'))), undefined, 'a timeout proves nothing');
  assert.equal(await nameMissing('x', dns(() => err('ESERVFAIL'), () => err('ESERVFAIL'), () => err('ESERVFAIL'))), undefined);
});

test('a busy server gets one more copy for CPU; more only while responses are slow', () => {
  const a = { on: true, min: 1, max: 5, lastChange: ago(10 * 60_000), lastWhy: '1 → 2: the server is busy (CPU 90%)' };
  const calm = { requests: 600, p95: 120, cpu: 90 };
  assert.equal(decide(2, a, { requests: 50, p95: 200, cpu: 92 }, calm).replicas, 2, 'the last copy didn’t calm the server: another won’t');
  assert.equal(decide(2, a, { requests: 900, p95: 1400, cpu: 92 }, calm).replicas, 3, 'slow responses still add one');
  assert.equal(decide(1, { on: true, min: 1, max: 5 }, { requests: 50, p95: 200, cpu: 92 }, calm).replicas, 2);
});

test('the bridge forgets dead watchers: stale claims go back, old requests expire, inbox_next gives the task id', async () => {
  const app = testApp(); const o = await testOrg(app);
  const conv = id('cnv');
  run(app.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', conv, o.orgId, o.userId, 'x');
  const t = enqueue(app, o.orgId, conv, 'help', o.userId);
  run(app.db, `UPDATE agent_tasks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ?`, o.userId, ago(31 * 60_000), t);
  assert.equal(isRunning(conv, app), false, 'a claim by a watcher that died doesn’t keep the conversation busy');
  const next = ok(await o.a('unit7.inbox_next', { wait: false }));
  assert.equal(next.taskId, t, 'the stale claim went back to the inbox, with the id inbox_done needs');
  ok(await o.a('unit7.inbox_done', { taskId: next.taskId }));
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM agent_tasks WHERE id = ?', t)!.status, 'done');
  const old = enqueue(app, o.orgId, conv, 'old', o.userId);
  run(app.db, 'UPDATE agent_tasks SET created_at = ? WHERE id = ?', ago(25 * 3600_000), old);
  assert.equal(isRunning(conv, app), false);
  assert.deepEqual(ok(await o.a('unit7.inbox_next', { wait: false })), { empty: true });
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM agent_tasks WHERE id = ?', old)!.status, 'expired');
});

test('an alert no channel took is sent again next time, not held back for 10 minutes', async () => {
  const app = testApp(); const o = await testOrg(app);
  setupNtfy(app, o.orgId);
  const ev = { id: 'e', org_id: o.orgId, type: 'service.down', severity: 'critical' as const, message: 'shop is down', project_id: null, environment_id: null, resource: 'svc_y', data: {}, created_at: now() };
  assert.equal(await deliver(app, ev, async () => { throw new Error('offline'); }), 0);
  assert.equal(await deliver(app, ev, async () => undefined), 1);
  assert.equal(await deliver(app, ev, async () => undefined), 0, 'once delivered, the repeat limit holds');
});

test('after a renewal, the next expiry warns again from the first threshold', async () => {
  const app = testApp(); const o = await testOrg(app);
  const inDays = (d: number) => new Date(Date.now() + d * 86400_000 + 3600_000).toISOString();
  const asset = id('ast');
  const expires = (d: number) => run(app.db, 'UPDATE assets SET meta = ? WHERE id = ?', JSON.stringify({ expires: inDays(d), autoRenew: false, registrar: 'porkbun' }), asset);
  run(app.db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, meta, seen_at) VALUES (?, ?, 'domain', 'domain', 'shop.com', 'shop.com', '{}', ?)`, asset, o.orgId, now());
  expires(20); await checkDaily(app, o.orgId);
  expires(400); await checkDaily(app, o.orgId); // renewed
  expires(20); await checkDaily(app, o.orgId); // a year later
  assert.equal(events(app, 'domain.expiring').length, 2);
});

test('an app whose settings could not be read gets no automatic connection', () => {
  const app = (envKeys?: string[]) => ({ provider: 'vercel', kind: 'app' as const, extId: 'p', name: 'shop', envKeys, uses: { supabase: true }, end: { kind: 'vercel' as const, accountId: 'acc_x', project: 'p' } });
  const db = { provider: 'supabase', kind: 'database' as const, extId: 'r', name: 'shop', end: { kind: 'supabase' as const, accountId: 'acc_y', ref: 'abcdefghabcdefghabcd' } };
  assert.equal(suggest(thingsFrom([app([]), db]), []).length, 1, 'settings read, none set: connect');
  assert.equal(suggest(thingsFrom([app(undefined), db]), []).length, 0, 'settings unknown: leave it');
});

test('Warden acts on the first sighting when one is enough', () => {
  const w = new Warden(testApp()) as unknown as { streak(k: string, a: boolean, n: number, c: number): string };
  assert.equal(w.streak('srv:abuse:203.0.113.5', true, 1, 60_000), 'fire');
  assert.equal(w.streak('srv:disk', true, 2, 60_000), 'hold');
  assert.equal(w.streak('srv:disk', true, 2, 60_000), 'fire');
});
