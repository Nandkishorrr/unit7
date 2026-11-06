// Two things Warden now does by itself, inside rules a person set: safe fixes with an undo (at "Fix itself" or higher,
// within limits, never on archived things or while paused), and restarts inside a server's restart window (a warning 10
// minutes before, a backup first, then a wait for SSH and every site). Servers are stand-ins (ssh exec replaced).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, get, id, json, run } from '../src/db.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { Warden } from '../src/sentinel/warden.ts';
import { serverFindings } from '../src/tools/security.ts';
import { whyNot } from '../src/tools/autofix.ts';
import { windowAt, windowWords, parseProbe, rebootTick, rebootDeps } from '../src/tools/reboot.ts';
import { saveXray } from '../src/tools/xray.ts';
import { assetIdOf } from '../src/archive.ts';
import { deliver } from '../src/sentinel/notify.ts';
import { setupNtfy } from '../src/connectors/oneclick.ts';
import type { App } from '../src/app.ts';

process.env.UNIT7_SKIP_NET_PROBE = '1';
const done = (stdout = '', code = 0) => ({ code, stdout, stderr: code ? 'failed' : '', truncated: false });
const events = (app: App, type: string) => all<{ message: string; data: string; severity: string }>(app.db, 'SELECT message, data, severity FROM events WHERE type = ? ORDER BY created_at', type);
async function setup() {
  const app = testApp(); const o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ web: 'unit7-caddy|caddy:2', sudo: 'root' }));
  return { app, o, srv };
}

// --- safe fixes, by itself ------------------------------------------------------------------------------------------------
// the security check's own reading of a server: databases published to the internet (safe to close, with an undo), an
// unknown program on 8888 (not marked safe), and a disk at 92% (safe, but no undo)
const DBS = [['shop-db', 'postgres:16', 5432], ['cache', 'redis:7', 6379], ['legacy', 'mysql:8', 3306], ['docs', 'mongo:7', 27017], ['search', 'elasticsearch:8', 9200], ['couch', 'couchdb:3', 5984], ['mc', 'memcached:1', 11211]] as const;
const audit = (dbs: readonly (readonly [string, string, number])[]) => `@@unit7 ufw\nStatus: active\n@@unit7 docker\n${dbs.map(([n, i, p]) => `${n}|${i}|0.0.0.0:${p}->${p}/tcp`).join('\n')}\nweb|nginx|0.0.0.0:8888->80/tcp\n@@unit7 disk\n92%\n@@unit7 end`;
function report(app: App, orgId: string, srv: string, dbs: readonly (readonly [string, string, number])[] = DBS.slice(0, 1)) {
  const { findings } = serverFindings({ id: srv, name: 'box', port: 22, provider_ref: null }, { web: 'unit7-caddy|caddy:2' }, audit(dbs));
  run(app.db, `INSERT INTO security_reports (id, org_id, server_id, by, score, counts, findings, notes, fresh, ms, created_at) VALUES (?, ?, NULL, 'Warden', 50, '{}', ?, '[]', '[]', 1, ?)`, id('sec'), orgId, JSON.stringify(findings), new Date().toISOString());
  return findings;
}
const portServer = (app: App) => { const seen: string[] = []; ssh(app).exec = async (_s, c: string) => { seen.push(c); return c.includes('unit7-close-') ? done('done') : done(); }; return seen; };
const applied = (app: App) => all<{ tool: string; input: string; undo: string; status: string; finding: string }>(app.db, 'SELECT tool, input, undo, status, finding FROM autofixes ORDER BY created_at');

test('at "Fix itself" Warden closes a published database by itself: as Warden through the gate, in Activity with Undo, calm on the phone', async () => {
  const { app, o, srv } = await setup();
  const seen = portServer(app);
  const findings = report(app, o.orgId, srv);
  assert.ok(findings.some((f) => f.fix && 'tool' in f.fix && f.fix.tool === 'docker.prune' && f.fix.safe && !f.fix.undo), 'a safe fix without an undo is in the report');
  assert.ok(findings.some((f) => f.fix && 'tool' in f.fix && f.fix.tool === 'server.close_port' && !f.fix.safe), 'an unsafe one too');
  const w = new Warden(app);
  await w.autofixNow();

  const a = get<{ actor_name: string; actor_kind: string; result: string; input: string }>(app.db, `SELECT actor_name, actor_kind, result, input FROM audit WHERE tool = 'server.close_port'`)!;
  assert.deepEqual({ who: a.actor_name, kind: a.actor_kind, result: a.result }, { who: 'Warden', kind: 'agent', result: 'success' });
  assert.equal(json<{ port: number }>(a.input, { port: 0 }).port, 5432);
  assert.ok(seen.some((c) => c.includes('unit7-close-')));
  assert.equal(all(app.db, `SELECT 1 FROM audit WHERE tool = 'docker.prune'`).length, 0, 'safe but no undo: only suggested');
  assert.equal(all(app.db, `SELECT 1 FROM audit WHERE tool = 'server.close_port'`).length, 1, 'the unsafe port 8888 stays a suggestion');

  // the undo is recorded with it, and Activity's Undo runs it
  const [row] = applied(app);
  assert.equal(row!.status, 'applied');
  assert.deepEqual(json(row!.undo, {}), { tool: 'server.close_port', input: { serverId: srv, port: 5432, open: true }, label: 'Open it again' });
  const [e] = events(app, 'autofix.applied');
  assert.equal(e!.message, 'Fixed by itself: A PostgreSQL database on box answers the internet, so Unit7 closed port 5432 to the internet · Undo');
  const undo = json<{ undo: { tool: string; input: unknown } }>(e!.data, {} as never).undo;
  ok(await o.h(undo.tool, undo.input));

  // never twice, even though the old report still shows it (and not after a person took it back)
  await w.autofixNow();
  assert.equal(applied(app).length, 1);

  // the phone: a calm "Fixed by itself"
  setupNtfy(app, o.orgId);
  const sent: RequestInit[] = [];
  const ev = get<{ id: string; type: string; severity: string; message: string; data: string; resource: string; created_at: string }>(app.db, `SELECT * FROM events WHERE type = 'autofix.applied'`)!;
  assert.equal(await deliver(app, { ...ev, org_id: o.orgId, severity: 'success', project_id: null, environment_id: null, data: json(ev.data, {}) }, async (_u, i) => { sent.push(i); }), 1);
  assert.deepEqual([(sent[0]!.headers as Record<string, string>).Title, (sent[0]!.headers as Record<string, string>).Priority], ['Unit7: Fixed by itself', '2']);
  assert.match(String(sent[0]!.body), /^Fixed by itself: .* · Undo/);
});

test('below "Fix itself", paused, switched off or archived: Warden only suggests, as before', async () => {
  // below "Fix itself"
  let { app, o, srv } = await setup();
  portServer(app); report(app, o.orgId, srv);
  run(app.db, 'UPDATE orgs SET autonomy = 2 WHERE id = ?', o.orgId);
  await new Warden(app).autofixNow();
  assert.equal(applied(app).length, 0);

  // paused
  ({ app, o, srv } = await setup());
  portServer(app); report(app, o.orgId, srv);
  ok(await o.h('autopilot.set', { paused: true }));
  await new Warden(app).autofixNow();
  assert.equal(applied(app).length, 0);

  // the switch: people only; off means suggestions only
  ({ app, o, srv } = await setup());
  portServer(app); report(app, o.orgId, srv);
  assert.equal((await o.a('autofix.settings', { on: false })).status, 'denied', 'an AI never sets its own leash');
  assert.equal(ok(await o.h('autofix.settings', { on: false })).on, false);
  await new Warden(app).autofixNow();
  assert.equal(applied(app).length, 0);
  assert.equal(ok(await o.h('autofix.status')).working, false);

  // archived: the database behind the port
  ({ app, o, srv } = await setup());
  portServer(app); report(app, o.orgId, srv);
  saveXray(app.db, o.orgId, srv, 'fast', { version: 1, at: new Date().toISOString(), server: {}, paas: [], projects: [], loose: [], ports: [], repos: [], summary: '', notes: [],
    parts: [{ id: 'c:shop-db', kind: 'database', name: 'shop-db', owner: 'compose', trust: 'seen', containers: ['shop-db'], ports: [{ port: 5432, proto: 'tcp', ip: '0.0.0.0', public: true }] }] });
  run(app.db, `INSERT INTO archived (org_id, key, name, kind) VALUES (?, ?, 'shop-db', 'database')`, o.orgId, assetIdOf(o.orgId, `compose:${srv}/c:shop-db`));
  await new Warden(app).autofixNow();
  assert.equal(applied(app).length, 0, 'archived: Unit7 leaves it alone');
});

test('limits: at most 5 fixes an hour per organisation, and one try per finding a day', async () => {
  const { app, o, srv } = await setup();
  portServer(app);
  const findings = report(app, o.orgId, srv, DBS);
  const w = new Warden(app);
  await w.autofixNow();
  assert.equal(applied(app).length, 5);
  await w.autofixNow();
  assert.equal(applied(app).length, 5, 'the hour’s five are used');
  // a finding tried today (even one that failed) waits until tomorrow, whatever its input says now
  const f = findings.find((x) => x.id === `server:port:${srv}:11211`)!;
  run(app.db, `DELETE FROM autofixes WHERE org_id = ?`, o.orgId);
  run(app.db, `INSERT INTO autofixes (id, org_id, server_id, finding, title, tool, input, status) VALUES (?, ?, ?, ?, 't', 'server.close_port', '{}', 'failed')`, id('afx'), o.orgId, srv, f.id);
  assert.equal(whyNot(app.db, o.orgId, { finding: f, fix: f.fix as never }), 'tried this one today already');
  assert.equal(whyNot(app.db, o.orgId, { finding: f, fix: f.fix as never }, Date.now() + 25 * 3600_000), undefined, 'the next day it may');
});

// --- restart windows ------------------------------------------------------------------------------------------------------
test('the window: inside, the next one, past midnight, and in server time', () => {
  const sun = Date.UTC(2026, 9, 11); // a Sunday, 00:00 UTC
  const w = { days: [0], start: '03:00', minutes: 60, offset: 120 }; // the server runs on UTC+2
  assert.deepEqual(windowAt(w, sun + 90 * 60_000), { inside: true, start: sun + 60 * 60_000, end: sun + 120 * 60_000 }, '01:30 UTC is 03:30 on the server');
  assert.equal(windowAt(w, sun + 3 * 3600_000).inside, false);
  assert.equal(windowAt(w, sun + 3 * 3600_000).start, sun + 7 * 86400_000 + 3600_000, 'next Sunday');
  const late = { days: [6], start: '23:30', minutes: 60, offset: 0 };
  assert.equal(windowAt(late, sun + 15 * 60_000).inside, true, 'Saturday’s window runs past midnight into Sunday');
  assert.equal(windowWords(w), 'Sundays 03:00–04:00, server time');
  assert.equal(windowWords({ days: [0, 6], start: '02:30', minutes: 45, offset: 0 }), 'Weekends 02:30–03:15, server time');
  assert.equal(windowWords({ days: [1, 3], start: '04:00', minutes: 60, offset: 0 }), 'Mondays and Wednesdays 04:00–05:00, server time');
  // what a server says is checked: a silly offset or boot id is ignored
  assert.deepEqual(parseProbe('reboot=yes\noffset=+0530\nboot=0b5e6c1e-1f6e-4a63-9a64-3f2b3a3e9d10'), { reboot: true, offset: 330, boot: '0b5e6c1e-1f6e-4a63-9a64-3f2b3a3e9d10' });
  assert.deepEqual(parseProbe('offset=+9900\nboot=$(rm -rf /)'), { reboot: false });
});

// a server that needs a restart and comes back (boot id changes), with one site that's back a moment later
const BOOT_A = '0b5e6c1e-1f6e-4a63-9a64-3f2b3a3e9d10', BOOT_B = '7d2f1a44-0c3e-4b7a-8a51-2e9f6b1c0d22';
function restartable(app: App, o: { comesBack?: boolean; siteBack?: boolean; dumpFails?: boolean } = {}) {
  const st = { rebooted: false, seen: [] as string[], downChecks: 0 };
  ssh(app).exec = async (_s, c: string, _o: ExecOptions = {}) => {
    st.seen.push(c);
    if (c.includes('reboot-required')) return done(`reboot=${st.rebooted ? 'no' : 'yes'}\noffset=+0000\nboot=${st.rebooted ? BOOT_B : BOOT_A}`);
    if (c.includes('systemctl reboot')) { st.rebooted = true; return done('ok'); }
    if (o.dumpFails && c.includes('pg_dump')) return done('', 1);
    return done();
  };
  let siteChecks = 0;
  Object.assign(rebootDeps, {
    pollMs: 1, downMs: 50, upMs: 80, sitesMs: 80, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    listening: async () => { if (!st.rebooted) return true; if (st.downChecks++ < 2) return false; return o.comesBack !== false; },
    probe: async () => { if (!st.rebooted) return { ok: true, ms: 1 }; siteChecks++; return { ok: o.siteBack !== false && siteChecks > 2, ms: 1 }; },
  });
  return st;
}
function windowNow(app: App, orgId: string, srv: string) {
  const start = new Date(Date.now() - 60_000);
  const hm = `${String(start.getUTCHours()).padStart(2, '0')}:${String(start.getUTCMinutes()).padStart(2, '0')}`;
  run(app.db, `INSERT INTO reboot_windows (server_id, org_id, days, start, minutes, utc_offset, set_by) VALUES (?, ?, ?, ?, 60, 0, 'Sam')`, srv, orgId, JSON.stringify([start.getUTCDay()]), hm);
  return Date.parse(`${start.toISOString().slice(0, 16)}:00.000Z`);
}
const site = (app: App, orgId: string, srv: string) => saveXray(app.db, orgId, srv, 'fast', { version: 1, at: new Date().toISOString(), server: {}, paas: [], projects: [], loose: [], ports: [], repos: [], summary: '', notes: [],
  parts: [{ id: 'd:app', kind: 'domain', name: 'app.example.com', owner: 'unmanaged', trust: 'seen' }] });

test('a person sets the window (an AI can’t); Warden warns 10 minutes before, then restarts inside it and checks everything came back', async () => {
  const { app, o, srv } = await setup();
  const st = restartable(app);
  site(app, o.orgId, srv);
  assert.equal((await o.a('reboot.window', { serverId: srv, days: [0], start: '03:00' })).status, 'denied', 'the window is a person’s OK, so only a person sets it');
  const set = ok(await o.h('reboot.window', { serverId: srv, days: [0], start: '03:00', minutes: 60 }));
  assert.equal(set.words, 'Sundays 03:00–04:00, server time');
  run(app.db, 'DELETE FROM reboot_windows WHERE server_id = ?', srv);
  const start = windowNow(app, o.orgId, srv);

  const w = new Warden(app);
  const calls: string[] = [];
  const act = (org: string, tool: string, input: unknown, reason: string) => { calls.push(tool); return (w as any).act(org, tool, input, reason); };
  // 10 minutes before: a warning, nothing else
  assert.equal((await rebootTick(app, act, start - 10 * 60_000)).length, 0);
  const [warn] = events(app, 'reboot.soon');
  assert.match(warn!.message, /^box restarts in 10 minutes to finish its updates \(its window: \w+ \d\d:\d\d–\d\d:\d\d, server time\)\. Unit7 backs up its databases first/);
  assert.equal(warn!.severity, 'warning');
  // inside the window, ten minutes later: the restart, as Warden through the gate
  const [pending] = await rebootTick(app, act);
  const r = await pending!;
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.deepEqual(calls, ['server.reboot']);
  assert.equal(get<{ actor_name: string }>(app.db, `SELECT actor_name FROM audit WHERE tool = 'server.reboot'`)!.actor_name, 'Warden');
  assert.ok(st.seen.some((c) => c.includes('systemctl reboot')));
  assert.deepEqual((r as any).output.sites, ['app.example.com'], 'waited for the site that answered before');
  assert.match(events(app, 'reboot.done')[0]!.message, /^Restarted box to finish its updates: back in \d+ seconds, and its site answers\.$/);
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM servers WHERE id = ?', srv)!.status, 'ready');
  // once per window
  assert.equal((await rebootTick(app, act)).length, 0);
});

test('never outside the window, never paused, never during a deploy, never two at once; a backup first or no restart', async () => {
  const { app, o, srv } = await setup();
  const st = restartable(app, { dumpFails: true });
  const w = new Warden(app);
  const act = (org: string, tool: string, input: unknown, reason: string) => (w as any).act(org, tool, input, reason);
  // no window: a restart is a change to something live, so Warden and AIs ask a person first; even at Full autopilot,
  // where the gate would let it through, Warden itself refuses outside a window
  assert.equal((await act(o.orgId, 'server.reboot', { serverId: srv }, 'test') as any).status, 'approval_required');
  assert.equal((await o.a('server.reboot', { serverId: srv })).status, 'approval_required');
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  assert.equal((await (new Warden(app) as any).act(o.orgId, 'server.reboot', { serverId: srv }, 'at full autopilot')).error.code, 'outside_window'); // (a fresh Warden: the first one waits before asking again)
  run(app.db, 'UPDATE orgs SET autonomy = 3 WHERE id = ?', o.orgId);
  // paused (a fresh Warden from here: the first one waits before asking again)
  const w2 = new Warden(app);
  const tickAct = (org: string, tool: string, input: unknown, reason: string) => (w2 as any).act(org, tool, input, reason);
  const start = windowNow(app, o.orgId, srv);
  run(app.db, `UPDATE reboot_windows SET warned_for = ?, warned_at = ? WHERE server_id = ?`, start, new Date(Date.now() - 11 * 60_000).toISOString(), srv);
  run(app.db, `UPDATE orgs SET paused_at = ? WHERE id = ?`, new Date().toISOString(), o.orgId);
  assert.equal((await rebootTick(app, tickAct)).length, 0);
  run(app.db, `UPDATE orgs SET paused_at = NULL WHERE id = ?`, o.orgId);
  // a deploy running on it
  const env = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] })).environments[0].id;
  const prj = get<{ project_id: string }>(app.db, 'SELECT project_id FROM environments WHERE id = ?', env)!.project_id;
  const svc = id('svc');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind) VALUES (?, ?, ?, ?, ?, 'db', 'db', 'postgres')`, svc, o.orgId, prj, env, srv);
  const dep = id('dep');
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status) VALUES (?, ?, ?, 1, 'building')`, dep, o.orgId, svc);
  assert.equal((await rebootTick(app, tickAct)).length, 0);
  run(app.db, `UPDATE deployments SET status = 'live' WHERE id = ?`, dep);
  // two servers due at once: one at a time
  const srv2 = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box2', '203.0.113.10', 'root', 'credential://ssh/box2/private-key', 'ready', '{}')`, srv2, o.orgId);
  windowNow(app, o.orgId, srv2);
  run(app.db, `UPDATE reboot_windows SET warned_for = ?, warned_at = ? WHERE server_id = ?`, start, new Date(Date.now() - 11 * 60_000).toISOString(), srv2);
  const pending = await rebootTick(app, tickAct);
  assert.equal(pending.length, 1, 'one server of an organisation restarts at a time');
  // ...and that one: its database (a fresh backup first) can't be backed up here, so nothing restarts
  const r = await pending[0]!;
  assert.equal((r as any).error?.code, 'backup_failed', JSON.stringify(r));
  assert.ok(get(app.db, `SELECT 1 FROM audit WHERE tool = 'backup.create' AND actor_name = 'Warden'`), 'the backup was tried first');
  assert.ok(!st.seen.some((c) => c.includes('systemctl reboot')), 'no backup, no restart');
});

test('what doesn’t come back opens an incident with the health check attached', async () => {
  // SSH never comes back
  let { app, o, srv } = await setup();
  restartable(app, { comesBack: false });
  let r = await o.h('server.reboot', { serverId: srv });
  assert.equal((r as any).error.code, 'not_back');
  const inc = events(app, 'incident.opened');
  assert.match(inc[0]!.message, /^Incident: box didn’t come back after restarting/);
  assert.ok(json<{ diagnosis?: { cause: string } }>(inc[0]!.data, {}).diagnosis?.cause, 'the Doctor’s look is attached');
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM servers WHERE id = ?', srv)!.status, 'unreachable', 'Warden keeps watching and says when it’s back');

  // the server is back, a site isn't
  ({ app, o, srv } = await setup());
  restartable(app, { siteBack: false });
  site(app, o.orgId, srv);
  r = await o.h('server.reboot', { serverId: srv });
  assert.deepEqual((r as any).output.down, ['app.example.com']);
  assert.match(events(app, 'incident.opened')[0]!.message, /^Incident: app\.example\.com didn’t come back after box restarted/);
  assert.equal(events(app, 'reboot.done')[0]!.severity, 'warning');
});
