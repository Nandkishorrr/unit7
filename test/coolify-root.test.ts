// Coolify with root on the server: Unit7 connects it by itself (its API switched on with an undo, 127.0.0.1 let
// through a set allow-list and nothing else, its own token made by Coolify's own code and read only from stdout),
// and changes its proxy the way Coolify keeps it (saved, checked, restarted, every site checked, put back when one
// stops answering, undone from Activity). The server runs Unit7's real shell scripts in a temp folder; `docker` and
// `curl` there are stand-ins that answer like Coolify 4.3.23 and its Traefik.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { all, get, id, json, run } from '../src/db.ts';
import { buildInventory } from '../src/discovery/xray.ts';
import { saveXray } from '../src/tools/xray.ts';
import { manageDirs } from '../src/tools/manage.ts';
import { proxyTiming } from '../src/tools/coolify.ts';
import { COOLIFY_PHP, CURL, CURL_IN_COOLIFY, proxyEdit, proxyFacts } from '../src/connectors/coolify.ts';
import { TRAFFIC_PROBE, accessLogFinding, traefikAccess } from '../src/sentinel/traffic.ts';
import { findingsFor } from '../src/discovery/findings.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';
import { PROXY, SITES, fakeHost, md5, shell } from './coolify-root-fixtures.ts';

const mac = hostname().split('.')[0]!.replace(/[^\w .()-]/g, '').trim().slice(0, 60) || 'this computer';
Object.assign(proxyTiming, { pollMs: 5, restartMaxMs: 3000, answerMaxMs: 300 });

async function setup(o: { allowed?: string | null; api?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-coolify-root-'));
  Object.assign(manageDirs, { undo: join(dir, 'undo') });
  const host = await fakeHost();
  host.st.allowed = o.allowed ?? null; host.st.api = o.api ?? false;
  const app = testApp();
  const org = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, org.orgId, JSON.stringify({ sudo: 'root' }));
  saveXray(app.db, org.orgId, srv, 'fast', buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' }));
  app.services.recheck = 'off'; // this fake server answers Coolify's commands, not an X-ray: no look-again after a fix here
  const sh = shell(dir, host.port);
  const calls: { command: string; stdin: string }[] = [];
  ssh(app).exec = async (_s, command, x: ExecOptions = {}) => { const stdin = String(x.stdin ?? ''); calls.push({ command, stdin }); return sh(command, stdin); };
  const everything = () => JSON.stringify([all(app.db, 'SELECT * FROM audit'), all(app.db, 'SELECT * FROM events'), all(app.db, 'SELECT * FROM changes'), all(app.db, 'SELECT * FROM approvals')]);
  return { app, o: org, srv, dir, host, st: host.st, calls, everything };
}
const unit7Tokens = <T extends { name: string }>(st: { tokens: T[] }) => st.tokens.filter((t) => t.name.startsWith('Unit7 ('));

test('connect automatically: the API switched on (with an undo), Unit7’s own token made on the server and read only from stdout', async () => {
  const c = await setup();
  try {
    const shown = ok(await c.o.h('coolify.connect', { serverId: c.srv }));
    assert.equal(shown.connected, null);
    assert.equal(shown.auto.length, 4, 'what “Connect automatically” will do, in four lines');
    const asked = await c.o.a('coolify.connect', { serverId: c.srv, auto: true });
    assert.equal(asked.status, 'approval_required', 'an AI asks a person first');
    assert.equal((await c.o.a('coolify.connect', { serverId: c.srv, auto: true, readSecrets: true })).status, 'denied', 'reading secret settings is a person’s choice');

    const r = ok(await c.o.h('coolify.connect', { serverId: c.srv, auto: true }));
    assert.equal(r.status, 'verified');
    assert.equal(r.mode, 'automatic');
    assert.equal(r.version, '4.3.23');
    assert.deepEqual(r.abilities, ['read', 'write', 'deploy', 'delete']);
    assert.equal(r.key, `Unit7 (${mac})`);
    assert.match(r.apiChange, /was off: Unit7 turned it on/);
    assert.equal(c.st.api, true);
    const [t] = unit7Tokens(c.st);
    assert.deepEqual([t!.name, t!.abilities], [`Unit7 (${mac})`, ['read', 'write', 'deploy', 'delete']]);
    const acc = get<{ id: string; meta: string; status: string }>(c.app.db, `SELECT id, meta, status FROM accounts WHERE provider = 'coolify'`)!;
    assert.equal(acc.status, 'verified');
    assert.equal(c.app.vault.resolve(c.o.orgId, json<{ ref: string }>(acc.meta, { ref: '' }).ref), t!.plain, 'kept in the vault like a pasted one');
    assert.deepEqual(json<{ facts: { abilities: string[] }; tokenId: string; made: string }>(acc.meta, {} as never).facts.abilities, ['read', 'write', 'deploy', 'delete']);
    assert.ok(c.st.calls.some((x) => x.path === '/version') && c.st.calls.some((x) => x.path === '/team'), 'checked with /version and /team');

    // the exact commands: Coolify's PHP on stdin, the API through curl's stdin; the token on no command line, in no record
    const phpCalls = c.calls.filter((x) => x.command === COOLIFY_PHP);
    assert.deepEqual(c.st.php.map((x) => x.op), ['connect']);
    assert.equal(phpCalls.length, 1);
    assert.match(phpCalls[0]!.stdin, /^<\?php\n/);
    assert.match(phpCalls[0]!.stdin, /session\(\['currentTeam' => \$team\]\);\n {2}\$t = \$user->createToken\(/, 'Coolify’s own createToken, after the team it reads from the web session');
    assert.ok(c.calls.every((x) => !x.command.includes(t!.plain) && !x.command.includes(t!.plain.slice(3))), 'never on a command line');
    assert.ok(!phpCalls[0]!.stdin.includes(t!.plain), 'the token only ever comes back out');
    assert.ok(c.calls.some((x) => x.command === CURL && x.stdin.includes(`Bearer ${t!.plain}`)), 'it goes to curl on stdin');
    assert.ok(!c.everything().includes(t!.plain.slice(3)), 'not in audit, events, changes or approvals');
    assert.ok(!JSON.stringify(r).includes(t!.plain.slice(3)), 'not in the result');

    // turning the API on is a change Activity can undo
    const ch = get<{ id: string; verb: string; summary: string; undo: string }>(c.app.db, 'SELECT id, verb, summary, undo FROM changes WHERE id = ?', r.changeId)!;
    assert.deepEqual([ch.verb, ch.summary], ['coolify_api', 'Turned on Coolify’s API']);
    const step = JSON.parse(ch.undo).steps[0] as string;
    assert.match(step, /^sh -c '.*' unit7 '[^']+\/coolify-api\.php' '[0-9a-f]{64}'$/s, 'the undo knows its copy’s path and hash');
    assert.ok(get(c.app.db, `SELECT 1 FROM events WHERE type = 'change.made' AND json_extract(data, '$.changeId') = ?`, r.changeId));
    const u = ok(await c.o.h('change.undo', { changeId: r.changeId }));
    assert.match(u.undone, /Turned on Coolify’s API/);
    assert.equal(c.st.api, false, 'back off, as it was');
    assert.equal(c.st.php.at(-1)!.op, 'settings');
  } finally { c.host.close(); }
});

test('the allow-list: 127.0.0.1 only, only when a list is set, never wider, and the API is then called from inside Coolify', async () => {
  for (const [allowed, want] of [[null, null], ['', ''], ['0.0.0.0', '0.0.0.0'], ['127.0.0.0/8', '127.0.0.0/8'], ['198.51.100.7, 203.0.113.0/24', '198.51.100.7,203.0.113.0/24,127.0.0.1']] as const) {
    const c = await setup({ allowed, api: true });
    try {
      const r = ok(await c.o.h('coolify.connect', { serverId: c.srv, auto: true }));
      assert.equal(r.status, 'verified', String(allowed));
      assert.equal(c.st.allowed, want, `${allowed} → ${want}`);
      if (want === allowed) assert.equal(r.changeId, undefined, 'nothing to undo when nothing changed');
      else {
        assert.match(r.apiChange, /127\.0\.0\.1/);
        assert.ok(c.calls.some((x) => x.command === CURL_IN_COOLIFY), 'refused on the host, then asked from inside Coolify');
        assert.ok(c.st.calls.some((x) => x.via === 'inside' && x.path === '/version'));
        ok(await c.o.h('change.undo', { changeId: r.changeId }));
        assert.equal(c.st.allowed, '198.51.100.7, 203.0.113.0/24', 'the person’s list exactly as it was');
      }
    } finally { c.host.close(); }
  }
});

test('connecting again replaces Unit7’s own token; disconnect deletes it in Coolify and forgets it; a person’s tokens stay', async () => {
  const c = await setup({ api: true });
  try {
    const a = ok(await c.o.h('coolify.connect', { serverId: c.srv, auto: true }));
    const first = unit7Tokens(c.st)[0]!;
    const b = ok(await c.o.h('coolify.connect', { serverId: c.srv, auto: true, readSecrets: true }));
    assert.equal(b.accountId, a.accountId, 'the same account, a new version of its credential');
    assert.equal(unit7Tokens(c.st).length, 1, 'never two');
    const second = unit7Tokens(c.st)[0]!;
    assert.notEqual(second.id, first.id);
    assert.deepEqual(second.abilities, ['read', 'write', 'deploy', 'delete', 'read:sensitive']);
    assert.deepEqual(c.st.php.at(-1)!.input.revoke, first.id, 'the old one by the id Unit7 kept');
    assert.match(b.replaced, /earlier key was deleted/);
    assert.equal(c.app.vault.resolve(c.o.orgId, json<{ ref: string }>(get<{ meta: string }>(c.app.db, `SELECT meta FROM accounts WHERE id = ?`, a.accountId)!.meta, { ref: '' }).ref), second.plain);
    assert.ok(c.st.tokens.some((t) => t.name === 'My laptop'), 'the person’s own token is never touched');

    assert.equal((await c.o.a('coolify.disconnect', { serverId: c.srv })).status, 'approval_required', 'an AI asks first');
    const d = ok(await c.o.h('coolify.disconnect', { serverId: c.srv }));
    assert.deepEqual([d.disconnected, d.deleted], [true, 1]);
    assert.equal(unit7Tokens(c.st).length, 0);
    assert.ok(c.st.tokens.some((t) => t.name === 'My laptop'));
    assert.equal(get(c.app.db, `SELECT 1 FROM accounts WHERE provider = 'coolify'`), undefined, 'forgotten');
    assert.equal(get(c.app.db, `SELECT 1 FROM secrets WHERE ref LIKE 'credential://coolify/%' AND retired_at IS NULL`), undefined, 'no version of the key is in use');
    // retired like every other vault entry, not erased: restorable for 30 days, then purged
    const kept = get<{ ref: string; n: number; v: number }>(c.app.db, `SELECT ref, count(*) n, max(version) v FROM secrets WHERE ref LIKE 'credential://coolify/%' AND retired_at IS NOT NULL GROUP BY ref`)!;
    assert.equal(kept.n, 2, 'both versions, retired');
    c.app.vault.restore(c.o.orgId, kept.ref, kept.v);
    assert.equal(c.app.vault.resolve(c.o.orgId, kept.ref), second.plain);
    assert.ok(!c.everything().includes(second.plain.slice(3)));
  } finally { c.host.close(); }
});

test('a pasted token still works, and disconnecting it leaves it in Coolify (it’s the person’s)', async () => {
  const c = await setup({ api: true });
  try {
    const mine = c.st.tokens[0]!;
    const r = ok(await c.o.h('coolify.connect', { serverId: c.srv, token: mine.plain }));
    assert.equal(r.status, 'verified');
    assert.deepEqual(r.abilities, ['read', 'read:sensitive', 'write', 'deploy'], 'a root token: write is found too, without changing anything');
    const d = ok(await c.o.h('coolify.disconnect', { serverId: c.srv }));
    assert.equal(d.deleted, 0);
    assert.match(d.note, /pasted in, so it’s yours/);
    assert.ok(c.st.tokens.includes(mine));
    assert.deepEqual(c.st.php, [], 'nothing ran in Coolify');
  } finally { c.host.close(); }
});

test('the proxy: status, close the dashboard, access log on, saved the way Coolify keeps it, and undone from Activity', async () => {
  const c = await setup();
  try {
    const s0 = ok(await c.o.h('coolify.proxy', { serverId: c.srv }));
    assert.deepEqual([s0.dashboard.open, s0.dashboard.port8080, s0.accessLog.on], [true, true, false]);
    assert.match(s0.settings, /Coolify’s database/);
    assert.equal((await c.o.a('coolify.proxy', { serverId: c.srv, op: 'close_dashboard' })).status, 'approval_required', 'tier 2: an AI asks first in production');

    const closed = ok(await c.o.h('coolify.proxy', { serverId: c.srv, op: 'close_dashboard' }));
    assert.equal(closed.changed, true);
    assert.equal(closed.checked, SITES.length, 'every site was checked after the restart');
    assert.ok(!c.st.config.includes("'8080:8080'") && c.st.config.includes("'--api.insecure=false'") && c.st.config.includes('traefik.enable=false'));
    assert.ok(c.st.config.includes('# Cloudflare in front: keep its addresses') && c.st.config.includes('trustedIPs=173.245.48.0/20'), 'the person’s own lines stay');
    assert.equal(c.st.running, c.st.config, 'restarted with it');
    const saves = c.st.php.filter((x) => x.op === 'proxy_save');
    assert.equal(saves.length, 1);
    assert.equal(saves[0]!.input.expect, md5(PROXY), 'refused if anyone changed it after Unit7 read it');
    const at = (f: (x: { command: string; stdin: string }) => boolean) => c.calls.findIndex(f);
    const saved = at((x) => x.command === COOLIFY_PHP && x.stdin.includes('unit7:proxy_save'));
    assert.ok(at((x) => x.command.includes('docker compose -f "$1" config -q')) < saved, 'checked by Compose before Coolify saved it');
    assert.ok(at((x) => x.stdin.includes('// unit7:proxy_save') && x.command.includes('cat > "$1"')) < saved, 'the undo kept on the server first');
    const undoFile = readdirSync(manageDirs.undo).map((d) => join(manageDirs.undo, d, 'coolify-proxy-undo.php')).find(existsSync)!;
    assert.match(readFileSync(undoFile, 'utf8'), /unit7:proxy_save/, 'Coolify’s own save of the old settings, kept on the server');
    // a later Restart Proxy in Coolify starts from its database: still closed
    c.st.pending = true;
    const again = ok(await c.o.h('coolify.proxy', { serverId: c.srv }));
    assert.deepEqual([again.dashboard.open, again.dashboard.port8080], [false, false]);
    assert.equal(ok(await c.o.h('coolify.proxy', { serverId: c.srv, op: 'close_dashboard' })).already, true);

    const on = ok(await c.o.h('coolify.proxy', { serverId: c.srv, op: 'access_log_on' }));
    assert.equal(on.changed, true);
    assert.equal(on.log, '/data/coolify/proxy/access.log');
    assert.ok(c.calls.some((x) => x.command.endsWith(`'docker pull -q "$1" >/dev/null 2>&1; true' unit7 'alpine:3'`)), 'the helper image is there before the proxy stops');
    const s1 = ok(await c.o.h('coolify.proxy', { serverId: c.srv }));
    assert.deepEqual([s1.accessLog.on, s1.accessLog.json, s1.accessLog.file, s1.accessLog.onServer, s1.accessLog.rotated, s1.accessLog.signIns], [true, true, '/traefik/access.log', '/data/coolify/proxy/access.log', true, true]);
    assert.ok(get(c.app.db, `SELECT 1 FROM events WHERE type = 'change.made' AND json_extract(data, '$.changeId') = ?`, on.changeId), 'Activity shows it with Undo');

    const u = ok(await c.o.h('change.undo', { changeId: on.changeId }));
    assert.match(u.undone, /access log/);
    assert.ok(!c.st.config.includes('--accesslog') && !c.st.config.includes('traefik-logrotate'), 'back to how it was');
    assert.ok(!c.st.config.includes("'8080:8080'"), 'the earlier change stays');
    assert.equal(c.st.pending, true, 'the undo asked Coolify to restart the proxy');
    assert.equal(get<{ status: string }>(c.app.db, 'SELECT status FROM changes WHERE id = ?', on.changeId)!.status, 'undone');

    // an undo never writes over settings someone changed since
    c.st.config += '\n# the person edited it in Coolify\n';
    assert.match((await c.o.h('change.undo', { changeId: closed.changeId }) as any).error.message, /changed since Unit7 read them/);
  } finally { c.host.close(); }
});

test('a site that stops answering after the change puts the old proxy settings back by itself', async () => {
  const c = await setup();
  try {
    c.st.down = (cfg) => (cfg.includes('--accesslog') ? ['shop.example.com'] : []);
    const r = ok(await c.o.h('coolify.proxy', { serverId: c.srv, op: 'access_log_on' }));
    assert.equal(r.changed, false);
    assert.equal(r.rolledBack, true);
    assert.match(r.why, /shop\.example\.com stopped answering, so Unit7 put the old settings back/);
    assert.equal(c.st.config, PROXY, 'Coolify’s saved settings are exactly the old ones');
    if (c.st.pending) ok(await c.o.h('coolify.proxy', { serverId: c.srv }));
    assert.equal(c.st.running, PROXY, 'and running');
    assert.equal(get<{ status: string }>(c.app.db, 'SELECT status FROM changes WHERE id = ?', r.changeId)!.status, 'rolled_back');
    assert.ok(get(c.app.db, `SELECT 1 FROM events WHERE type = 'change.rolled_back'`));
    assert.ok(!get(c.app.db, `SELECT 1 FROM events WHERE type = 'change.made' AND json_extract(data, '$.changeId') = ?`, r.changeId), 'never offered as an undo');
  } finally { c.host.close(); }
});

test('the proxy settings are edited line by line: only what matters changes, and on/off round-trips exactly', () => {
  const closed = proxyEdit(PROXY, 'close_dashboard');
  assert.deepEqual(closed.changed.length, 3);
  const on = proxyEdit(closed.text, 'access_log_on');
  assert.ok(on.text.startsWith(closed.text.split('    labels:')[0]!.replace(/\n {6}# Cloudflare[\s\S]*$/, '')), 'everything before the new lines is as it was');
  assert.match(on.text, /\n {2}traefik-logrotate:\n {4}container_name: coolify-proxy-logrotate\n {4}image: 'alpine:3'\n {4}restart: unless-stopped\n {4}network_mode: none\n {4}volumes:\n {6}- '\/data\/coolify\/proxy\/:\/traefik'/);
  assert.match(on.text, /\$\$\(stat -c %s "\$\$log"/, 'Compose reads $ as its own, so the helper’s are doubled');
  assert.deepEqual(proxyEdit(on.text, 'access_log_on').changed, [], 'twice is once');
  assert.equal(proxyEdit(on.text, 'access_log_off').text, closed.text, 'off is exactly as before on');
  assert.throws(() => proxyEdit(PROXY.replace(/ {4}command:\n( {6}.*\n)+/, "    command: ['--ping=true']\n"), 'access_log_on'), /doesn’t edit/);
  assert.throws(() => proxyEdit('services:\n  caddy:\n    image: caddy\n', 'close_dashboard'), /Traefik service/);
  // labels that aren't exactly Coolify's old dashboard route are left alone (like Coolify 4.4 does)
  assert.ok(proxyEdit(PROXY.replace('      - coolify.proxy=true', '      - coolify.proxy=true\n      - traefik.http.routers.mine.rule=Host(`x.example.com`)'), 'close_dashboard').text.includes('traefik.enable=true'));
});

test('fix wiring: the open :8080 dashboard and the missing access log are one click, and Watch’s reader finds the log', () => {
  const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' });
  const f = findingsFor({ serverId: 'srv_test0000000a', serverName: 'box', inv, history: { memMax: {}, restarts: {}, oom: {}, daily: [] } });
  const dash = f.find((x) => x.id === 'server:port:srv_test0000000a:8080')!;
  assert.deepEqual([(dash.fix as any).tool, (dash.fix as any).input, (dash.fix as any).label], ['coolify.proxy', { serverId: 'srv_test0000000a', op: 'close_dashboard' }, 'Close it in Coolify']);
  assert.ok(f.some((x) => x.id === 'server:port:srv_test0000000a:5432' && (x.fix as any).tool === 'server.close_port'), 'other open ports still close at the firewall');
  const log = accessLogFinding({ serverId: 'srv_test0000000a', serverName: 'box' }, { on: false })!;
  assert.deepEqual([(log.fix as any).tool, (log.fix as any).input], ['coolify.proxy', { serverId: 'srv_test0000000a', op: 'access_log_on' }]);
  assert.doesNotMatch(JSON.stringify([f, log]), /never changes Coolify/);
  // after access_log_on, the running proxy's arguments are what the traffic probe reads: file, JSON, sign-in headers
  const args = JSON.stringify(proxyFacts(proxyEdit(PROXY, 'access_log_on').text).command);
  assert.deepEqual(traefikAccess(args), { on: true, file: '/traefik/access.log', format: 'json', headers: true });
  assert.match(TRAFFIC_PROBE, /--accesslog\.filepath=[\s\S]*docker exec coolify-proxy tail -n 100000 "\$f"/, 'the probe tails the file its arguments name');
});
