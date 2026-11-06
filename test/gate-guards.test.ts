// Four places where a quiet default did more than the person chose: a box with only UDP services (or one Unit7 couldn't
// fully see) was "fresh" and got a firewall; any AI could restart a server inside its window; a readonly member could hide
// a finding for everyone; and a snooze kept the phone quiet after it ended, or when the thing got worse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, get, id, run } from '../src/db.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { freshness, preparing, afterKeyWorks } from '../src/tools/servers.ts';
import { rebootDeps } from '../src/tools/reboot.ts';
import { snooze, visible } from '../src/snooze.ts';
import { track, announce } from '../src/sentinel/watcher.ts';
import { deliver } from '../src/sentinel/notify.ts';
import { setupNtfy } from '../src/connectors/oneclick.ts';
import { probe } from './xray-fixtures.ts';
import type { App } from '../src/app.ts';

process.env.UNIT7_SKIP_NET_PROBE = '1';
const done = (stdout = '', code = 0) => ({ code, stdout, stderr: code ? 'failed' : '', truncated: false });
const WARDEN = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' } as const;
const events = (app: App, type: string) => all<{ message: string }>(app.db, 'SELECT message FROM events WHERE type = ?', type);

// --- M1: what counts as fresh --------------------------------------------------------------------------------------------
const look = (ports: { proto: string; ip: string; port: number }[]) => ({ paas: [], parts: [], projects: [], ports });
const SSH = { proto: 'tcp', ip: '0.0.0.0', port: 22 };

test('fresh: a UDP service counts as running; an empty look, or one without SSH, is unknown and never fresh', () => {
  const wg = freshness(look([SSH, { proto: 'udp', ip: '0.0.0.0', port: 51820 }]));
  assert.deepEqual(wg, { fresh: false, why: ['something answers on port 51820'] }, 'WireGuard, a kernel module with no service');
  assert.equal(freshness(look([SSH, { proto: 'udp', ip: '*', port: 1194 }, { proto: 'udp', ip: '0.0.0.0', port: 53 }])).fresh, false, 'OpenVPN and DNS');
  assert.deepEqual(freshness(look([SSH, { proto: 'udp', ip: '0.0.0.0', port: 68 }, { proto: 'udp', ip: 'fe80::1', port: 546 }, { proto: 'udp', ip: '0.0.0.0', port: 5353 }, { proto: 'udp', ip: '127.0.0.1', port: 323 }])),
    { fresh: true, why: [] }, 'the box’s own DHCP, mDNS and a local time server are the system');
  const blind = freshness(look([]));
  assert.equal(blind.fresh, false);
  assert.equal(blind.unknown, true, 'ss missing or timed out: nothing read');
  assert.equal(freshness(look([{ proto: 'udp', ip: '0.0.0.0', port: 68 }])).unknown, true, 'not even the SSH Unit7 came in through');
  assert.equal(freshness(look([{ proto: 'tcp', ip: '0.0.0.0', port: 2222 }]), 2222).fresh, true, 'SSH on its own port');
});

const FACTS = 'os=Ubuntu 24.04.1 LTS\nos_id=ubuntu\nkernel=6.8.0\narch=x86_64\ncpus=2\nmem_total=8000000000\nmem_available=7000000000\nswap_total=0\ndisk_total=80000000000\ndisk_used=5000000000\nuptime=100\nload=0.01 0.02 0.00\ndocker=27.3.1\ncompose=2.29.7\nhas=apt-get\nhas=systemctl\nhas=ufw\nhas=curl\nuser=root\nsudo=root\nports=22,\n';
const HOST = 'os=Ubuntu 24.04.1 LTS\ncpus=2\nmem_total=8000000000\nmem_available=7000000000\ndisk_total=80000000000\ndisk_used=5000000000\nload=0.01 0.02 0.00\ndocker=27.3.1\nuser=root\nhas_docker=1';
function machine(app: App, xray: string) {
  const seen: string[] = [];
  ssh(app).exec = async (_s, command: string, o: ExecOptions = {}) => {
    seen.push(command);
    if (command.includes('os_id=')) return done(FACTS);
    if (/sh -s$/.test(command) && String(o.stdin ?? '').includes('s ctrs')) return done(xray);
    return done();
  };
  return seen;
}

test('a box whose listeners couldn’t be read isn’t prepared by itself; a WireGuard box is shared, its firewall left alone', async () => {
  for (const [ports, want] of [['', 'unknown'], ['tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=700,fd=3))\nudp UNCONN 0 0 0.0.0.0:51820 0.0.0.0:*', 'shared']] as const) {
    const app = testApp(), o = await testOrg(app);
    const seen = machine(app, probe({ host: HOST, ports }));
    const srv = id('srv');
    run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.12', 'root', 'credential://ssh/box/private-key', 'connected', '{}')`, srv, o.orgId);
    assert.equal(afterKeyWorks(app, o.orgId, o.human, srv), 'checking');
    const r = await preparing.get(srv)!;
    assert.equal(r.prepare, want);
    assert.equal(get(app.db, `SELECT 1 FROM audit WHERE tool = 'server.bootstrap'`), undefined, 'not prepared by itself');
    assert.ok(!seen.some((c) => c.includes('ufw --force enable')));
    if (want === 'unknown') assert.match(events(app, 'server.prep_unknown')[0]!.message, /couldn’t see everything that runs on box/);
  }
});

// --- M2: restarts inside the window ---------------------------------------------------------------------------------------
const BOOT_A = '0b5e6c1e-1f6e-4a63-9a64-3f2b3a3e9d10', BOOT_B = '7d2f1a44-0c3e-4b7a-8a51-2e9f6b1c0d22';
function restartable(app: App) {
  const st = { rebooted: false, restarts: 0 };
  ssh(app).exec = async (_s, c: string) => {
    if (c.includes('reboot-required')) return done(`reboot=${st.rebooted ? 'no' : 'yes'}\noffset=+0000\nboot=${st.rebooted ? BOOT_B : BOOT_A}`);
    if (c.includes('systemctl reboot')) { st.rebooted = true; st.restarts++; return done('ok'); }
    return done();
  };
  let down = 0;
  Object.assign(rebootDeps, { pollMs: 1, downMs: 50, upMs: 80, sitesMs: 80, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    listening: async () => (!st.rebooted ? true : down++ >= 2), probe: async () => ({ ok: true, ms: 1 }) });
  return st;
}

test('inside the window only Warden restarts without asking, after its warning, when the server needs it, once', async () => {
  const app = testApp(), o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ web: 'unit7-caddy|caddy:2', sudo: 'root' }));
  const st = restartable(app);
  const start = new Date(Date.now() - 60_000);
  run(app.db, `INSERT INTO reboot_windows (server_id, org_id, days, start, minutes, utc_offset, set_by) VALUES (?, ?, ?, ?, 60, 0, 'Sam')`, srv, o.orgId, JSON.stringify([start.getUTCDay()]),
    `${String(start.getUTCHours()).padStart(2, '0')}:${String(start.getUTCMinutes()).padStart(2, '0')}`);
  const startMs = Date.parse(`${start.toISOString().slice(0, 16)}:00.000Z`);
  const warden = o.as(WARDEN as never);
  // any other AI, even inside the window, asks a person (and at Full autopilot it's a change with undo, as outside)
  assert.equal((await o.a('server.reboot', { serverId: srv })).status, 'approval_required');
  // Warden itself: not before its 10-minute warning
  const early = await warden('server.reboot', { serverId: srv });
  assert.equal(early.status === 'error' && early.error.code, 'not_warned');
  run(app.db, 'UPDATE reboot_windows SET warned_for = ?, warned_at = ? WHERE server_id = ?', startMs, new Date(Date.now() - 3 * 60_000).toISOString(), srv);
  const soon = await warden('server.reboot', { serverId: srv });
  assert.equal(soon.status === 'error' && soon.error.code, 'not_warned', 'the warning was only 3 minutes ago');
  run(app.db, 'UPDATE reboot_windows SET warned_at = ? WHERE server_id = ?', new Date(Date.now() - 11 * 60_000).toISOString(), srv);
  ok(await warden('server.reboot', { serverId: srv }));
  assert.equal(st.restarts, 1);
  // once per window: the warning is used up
  const twice = await warden('server.reboot', { serverId: srv });
  assert.equal(twice.status === 'error' && twice.error.code, 'not_warned');
  // and only when the server says it needs one
  run(app.db, 'UPDATE reboot_windows SET warned_for = ?, warned_at = ? WHERE server_id = ?', startMs, new Date(Date.now() - 11 * 60_000).toISOString(), srv);
  const needless = await warden('server.reboot', { serverId: srv });
  assert.equal(needless.status === 'error' && needless.error.code, 'not_needed');
  assert.equal(st.restarts, 1);
});

// --- M3: who may hide things -----------------------------------------------------------------------------------------------
test('hiding and bringing back are writes: readonly and auditor members can’t; owner, admin and developer can; never an AI', async () => {
  const app = testApp(), o = await testOrg(app);
  const key = 'server:ssh-password:srv_abcdefabcdef';
  for (const role of ['readonly', 'auditor'] as const) {
    const as = o.as(o.role(role));
    for (const [tool, input] of [['snooze.set', { key, for: 'forever', reason: 'fine' }], ['snooze.clear', { key }], ['home.dismiss', { id: key }], ['home.dismiss', { id: key, hide: false }]] as const) {
      assert.equal((await as(tool, input)).status, 'denied', `${role} ${tool}`);
    }
  }
  assert.equal(get(app.db, 'SELECT 1 FROM snoozes WHERE key = ?', key), undefined);
  for (const role of ['owner', 'admin', 'developer'] as const) {
    ok(await o.as(o.role(role))('snooze.set', { key, for: '7d' }));
    ok(await o.as(o.role(role))('snooze.clear', { key }));
    ok(await o.as(o.role(role))('home.dismiss', { id: key }));
  }
  for (const [tool, input] of [['snooze.set', { key, for: '7d' }], ['snooze.clear', { key }], ['home.dismiss', { id: key }]] as const) assert.equal((await o.a(tool, input)).status, 'denied', `AI ${tool}`);
});

// --- M4: a snooze is only as quiet as the person chose ---------------------------------------------------------------------
async function watched() {
  const app = testApp(), o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'k', 'ready', '{}')`, srv, o.orgId);
  return { app, o, srv, key: `server:ssh-guessing:${srv}` };
}

test('a snoozed alert isn’t marked as said: it reaches the phone once the snooze ends, and right away if it gets worse', async () => {
  // the reviewer's case: hidden until tomorrow while low; two days later it's critical
  let { app, o, srv, key } = await watched();
  const t0 = Date.now();
  track(app, o.orgId, srv, 'finding', [{ key, severity: 'low', title: 'Bots are guessing (keys only).' }], new Date(t0).toISOString());
  snooze(app.db, o.orgId, { key, for: 'tomorrow', by: 'Sam' }, t0);
  assert.equal(get<{ severity: string }>(app.db, 'SELECT severity FROM snoozes WHERE key = ?', key)!.severity, 'low', 'how serious it was, from Unit7’s own records');
  assert.equal(announce(app, o.orgId, { id: srv, name: 'box' }, 'finding', t0), undefined, 'hidden: quiet');
  assert.equal(get<{ alerted_at: string | null }>(app.db, 'SELECT alerted_at FROM watch_alerts WHERE key = ?', key)!.alerted_at, null, 'not marked as said');
  const t2 = t0 + 2 * 86400_000;
  track(app, o.orgId, srv, 'finding', [{ key, severity: 'critical', title: 'Bots are guessing passwords, and password sign-in is on.' }], new Date(t2).toISOString());
  assert.match(announce(app, o.orgId, { id: srv, name: 'box' }, 'finding', t2) ?? '', /password sign-in is on/);

  // hidden for 15 days while low; an hour later it's high: it says so now
  ({ app, o, srv, key } = await watched());
  track(app, o.orgId, srv, 'finding', [{ key, severity: 'low', title: 'Low.' }], new Date(t0).toISOString());
  snooze(app.db, o.orgId, { key, for: '15d', by: 'Sam' }, t0);
  track(app, o.orgId, srv, 'finding', [{ key, severity: 'high', title: 'Worse.' }], new Date(t0 + 3600_000).toISOString());
  assert.equal(announce(app, o.orgId, { id: srv, name: 'box' }, 'finding', t0 + 3600_000), 'box: Worse.');

  // "This is fine" for good never hides a critical one
  ({ app, o, srv, key } = await watched());
  track(app, o.orgId, srv, 'finding', [{ key, severity: 'critical', title: 'Critical.' }], new Date(t0).toISOString());
  snooze(app.db, o.orgId, { key, for: 'forever', by: 'Sam' }, t0);
  assert.equal(announce(app, o.orgId, { id: srv, name: 'box' }, 'finding', t0), 'box: Critical.');
});

test('lists and the phone: hidden while no worse, shown again (“Got worse since you hid it”) once it is', async () => {
  const app = testApp(), o = await testOrg(app);
  // a finding only a list shows (no record of it): the person's view says how serious it was
  ok(await o.h('snooze.set', { key: 'xray:no-backup:a', for: '7d', severity: 'low' }));
  assert.deepEqual(visible(app.db, o.orgId, [{ id: 'xray:no-backup:a', severity: 'low' }], (f) => f.id), [], 'no worse: hidden');
  assert.deepEqual(visible(app.db, o.orgId, [{ id: 'xray:no-backup:a', severity: 'high' }], (f) => f.id), [{ id: 'xray:no-backup:a', severity: 'high', back: 'Got worse since you hid it' }]);
  ok(await o.h('snooze.set', { key: 'xray:open-db:b', for: 'forever', severity: 'critical' }));
  assert.equal(visible(app.db, o.orgId, [{ id: 'xray:open-db:b', severity: 'critical' }], (f) => f.id).length, 1, 'a permanent “This is fine” never hides a critical one');

  // the phone: hidden at "warning", it buzzes when the same thing turns critical
  setupNtfy(app, o.orgId, o.userId);
  const sent: string[] = [];
  const send = async (_u: string, init: RequestInit) => { sent.push(String(init.body)); };
  app.events.emit(o.orgId, 'site.down', 'shop.example.com is slow to answer.', { severity: 'warning', resource: 'ast_c' });
  ok(await o.h('snooze.set', { key: 'event:site.down:ast_c', for: '7d', kind: 'event' }));
  const ev = (severity: 'warning' | 'critical') => ({ id: id('evt'), org_id: o.orgId, type: 'site.down', severity, message: 'shop.example.com is down.', project_id: null, environment_id: null, resource: 'ast_c', data: {}, created_at: new Date().toISOString() });
  assert.equal(await deliver(app, ev('warning') as never, send), 0, 'no worse: no buzz');
  assert.equal(await deliver(app, ev('critical') as never, send), 1, 'worse: it buzzes');
});
