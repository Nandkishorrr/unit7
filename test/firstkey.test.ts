// A new server, from nothing to ready: once Unit7's key works a fresh box prepares itself (and one that already runs
// things is shared, never reconfigured by itself), and the very first key can come from the root password, typed once,
// used once, kept nowhere. The password tests run a real SSH server in this process (ssh2) whose authorized_keys is a
// temporary folder: the script that adds keys runs for real, and Unit7 then signs in with its key to prove it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, get, id, json, run } from '../src/db.ts';
import { fingerprint, ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { buildInventory } from '../src/discovery/xray.ts';
import { freshness, preparing } from '../src/tools/servers.ts';
import { ADD_KEYS, macKeys } from '../src/tools/firstkey.ts';
import { probe, COOLIFY_HOST, COMPOSE_HOST, PM2_HOST } from './xray-fixtures.ts';
import type { App } from '../src/app.ts';

process.env.UNIT7_SKIP_NET_PROBE = '1';

// --- what a fresh box looks like to the X-ray ----------------------------------------------------------------------------
const SSHD = 'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=700,fd=3))\ntcp LISTEN 0 4096 [::]:22 [::]:* users:(("sshd",pid=700,fd=4))';
const RESOLVED = 'tcp LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=500,fd=14))\nudp UNCONN 0 0 127.0.0.1:323 0.0.0.0:* users:(("chronyd",pid=600,fd=5))\nudp UNCONN 0 0 0.0.0.0:68 0.0.0.0:* users:(("dhclient",pid=650,fd=6))';
const HOST = 'os=Ubuntu 24.04.1 LTS\ncpus=2\nmem_total=8000000000\nmem_available=7000000000\ndisk_total=80000000000\ndisk_used=5000000000\nload=0.01 0.02 0.00\ndocker=27.3.1\nuser=root\nhas_docker=1';
export const FRESH = probe({ host: HOST, ports: `${SSHD}\n${RESOLVED}` });
const NODE_ON_3000 = probe({ host: HOST, ports: `${SSHD}\ntcp LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=20))` });
const inv = (out: string) => buildInventory(out, { serverHost: '203.0.113.9' });

test('a fresh box is fresh; anything already running makes it shared, said in plain words', () => {
  assert.deepEqual(freshness(inv(FRESH)), { fresh: true, why: [] }, 'SSH, the local name resolver and DHCP are the system, not a project');
  // Unit7's own proxy from an earlier, half-finished preparation doesn't count
  const caddy = probe({ host: HOST, ports: `${SSHD}\ntcp LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=1080,fd=4))`,
    ctrs: JSON.stringify([{ Id: 'c1', Name: '/unit7-caddy', Image: 'sha256:x', Config: { Image: 'caddy:2.11.7-alpine', Labels: {}, Env: [] }, State: { Status: 'running', Pid: 1 }, RestartCount: 0, HostConfig: { RestartPolicy: { Name: 'unless-stopped' } }, NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '80' }] }, Networks: { unit7: {} } }, Mounts: [] }]) });
  assert.equal(freshness(inv(caddy)).fresh, true);
  const coolify = freshness(inv(COOLIFY_HOST));
  assert.equal(coolify.fresh, false);
  assert.match(coolify.why.join('; '), /Coolify runs here/);
  assert.match(freshness(inv(COMPOSE_HOST)).why.join('; '), /containers? runs? here/);
  assert.match(freshness(inv(PM2_HOST)).why.join('; '), /port 80 or 443|answers on port/);
  assert.deepEqual(freshness(inv(NODE_ON_3000)), { fresh: false, why: ['something answers on port 3000'] });
  assert.equal(freshness(inv(probe({ host: HOST, ports: SSHD.replace(/:22 /g, ':2222 ') })), 2222).fresh, true, 'SSH on its own port is still just SSH');
});

// --- the fake machine for preparing (ssh exec replaced): it says what it is, and records every command ------------------
const FACTS = 'os=Ubuntu 24.04.1 LTS\nos_id=ubuntu\nkernel=6.8.0\narch=x86_64\ncpus=2\nmem_total=8000000000\nmem_available=7000000000\nswap_total=0\ndisk_total=80000000000\ndisk_used=5000000000\nuptime=100\nload=0.01 0.02 0.00\ndocker=27.3.1\ncompose=2.29.7\nhas=apt-get\nhas=systemctl\nhas=ufw\nhas=curl\nuser=root\nsudo=root\nports=22,\n';
const done = (stdout = '', code = 0) => ({ code, stdout, stderr: '', truncated: false });
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
const events = (app: App, type: string) => all<{ message: string; data: string }>(app.db, 'SELECT message, data FROM events WHERE type = ?', type);
const KEY = () => ssh2.utils.generateKeyPairSync('ed25519').private;

test('a person connects a fresh box: Unit7 prepares it by itself, as that person, with live progress', async () => {
  const app = testApp(); const o = await testOrg(app);
  const seen = machine(app, FRESH);
  const live: string[] = [];
  app.events.on((e) => { if (e.type === 'server.prep') live.push(e.message); });
  const c = ok(await o.h('server.connect', { name: 'fresh', host: '203.0.113.9', privateKey: KEY() }));
  assert.equal(c.prepare, 'checking');
  const r = await preparing.get(c.serverId)!;
  assert.equal(r.prepare, 'started');
  assert.equal(r.result?.status, 'ok');
  const boot = get<{ actor_kind: string; actor_name: string; result: string }>(app.db, `SELECT actor_kind, actor_name, result FROM audit WHERE tool = 'server.bootstrap'`)!;
  assert.deepEqual({ ...boot }, { actor_kind: 'user', actor_name: 'Ada', result: 'success' }, 'through the gate, as the person who connected it');
  assert.ok(seen.some((c) => c.includes('ufw --force enable')), 'a fresh box gets the firewall');
  assert.ok(live.some((m) => /Caddy/.test(m)), 'progress streams live');
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM servers WHERE id = ?', c.serverId)!.status, 'ready');
  assert.match(events(app, 'server.preparing')[0]!.message, /is fresh, so Unit7 is preparing it now/);
});

test('a box that already runs things is never prepared by itself: it is shared, and later its firewall is left alone', async () => {
  const app = testApp(); const o = await testOrg(app);
  const seen = machine(app, NODE_ON_3000);
  const c = ok(await o.h('server.connect', { name: 'busy', host: '203.0.113.10', privateKey: KEY() }));
  const r = await preparing.get(c.serverId)!;
  assert.equal(r.prepare, 'shared');
  assert.equal(get(app.db, `SELECT 1 FROM audit WHERE tool = 'server.bootstrap'`), undefined, 'not prepared by itself');
  assert.match(events(app, 'server.shared')[0]!.message, /^This server already runs things: Unit7 will share it\. busy: something answers on port 3000\. Unit7 won’t change its firewall/);
  assert.ok(json<{ sharedHost?: string }>(get<{ facts: string }>(app.db, 'SELECT facts FROM servers WHERE id = ?', c.serverId)!.facts, {}).sharedHost);
  // the person asks for it later: shared-host mode, so nothing running on port 3000 is cut off
  const b = ok(await o.h('server.bootstrap', { serverId: c.serverId }));
  assert.ok(!seen.some((x) => x.includes('ufw --force enable')));
  assert.ok(b.steps.includes('Firewall left as it is: other apps on this server use their own ports.'));
  // asking again changes nothing: it's shared already
  ok(await o.h('server.repair', { serverId: c.serverId, fix: 'check-key' }));
  assert.equal(preparing.has(c.serverId), false);
});

test('an AI’s connect follows its autonomy: at "Ask first" the preparation waits for a person', async () => {
  const app = testApp(); const o = await testOrg(app);
  machine(app, FRESH);
  run(app.db, 'UPDATE orgs SET autonomy = 2 WHERE id = ?', o.orgId);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'ai-box', '203.0.113.11', 'root', 'credential://ssh/ai-box/private-key', 'connected', '{}')`, srv, o.orgId);
  const { afterKeyWorks } = await import('../src/tools/servers.ts');
  assert.equal(afterKeyWorks(app, o.orgId, o.agent, srv), 'checking');
  const r = await preparing.get(srv)!;
  assert.equal(r.result?.status, 'approval_required');
  assert.equal(get<{ status: string }>(app.db, `SELECT status FROM approvals WHERE tool = 'server.bootstrap'`)!.status, 'pending');
  // at "Fix itself" it runs, as the AI
  run(app.db, 'UPDATE orgs SET autonomy = 3 WHERE id = ?', o.orgId);
  afterKeyWorks(app, o.orgId, o.agent, srv);
  assert.equal((await preparing.get(srv)!).result?.status, 'ok');
  assert.equal(get<{ actor_kind: string }>(app.db, `SELECT actor_kind FROM audit WHERE tool = 'server.bootstrap' AND result = 'success'`)!.actor_kind, 'agent');
});

// --- the first key from the root password: a real SSH server in this process --------------------------------------------
const PASSWORD = 'Corr3ct-r00t-Passw0rd!';
const SHARED_XRAY = NODE_ON_3000;
async function sshServer(home: string) {
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519').private;
  const stats = { passwords: 0, wrong: 0, keyLogins: 0 };
  const file = join(home, '.ssh', 'authorized_keys');
  const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        stats.passwords++;
        if (ctx.username === 'root' && ctx.password === PASSWORD) return ctx.accept();
        stats.wrong++;
        return ctx.reject(['publickey', 'password']);
      }
      if (ctx.method === 'publickey') {
        const body = ctx.key.data.toString('base64');
        if (!existsSync(file) || !readFileSync(file, 'utf8').includes(body)) return ctx.reject(['publickey', 'password']);
        if (!ctx.signature) return ctx.accept();
        const pub = ssh2.utils.parseKey(`${ctx.key.algo} ${body}`);
        if (!(pub instanceof Error) && !Array.isArray(pub) && pub.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) { stats.keyLogins++; return ctx.accept(); }
        return ctx.reject(['publickey', 'password']);
      }
      ctx.reject(['publickey', 'password']);
    }).on('ready', () => client.on('session', (accept) => accept().on('exec', (acc, _rej, info) => {
      const stream = acc();
      if (info.command.includes('authorized_keys')) {
        // the key script runs for real, in a temporary home
        const child = spawn('/bin/sh', ['-c', info.command], { env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } });
        stream.pipe(child.stdin);
        child.stdout.pipe(stream, { end: false });
        child.stderr.on('data', (d) => stream.stderr.write(d));
        child.on('close', (code) => { stream.exit(code ?? 1); stream.end(); });
        return;
      }
      stream.on('data', () => undefined);
      stream.write(info.command.includes('os_id=') ? FACTS : /sh -s$/.test(info.command) ? SHARED_XRAY : '');
      stream.exit(0); stream.end();
    }))).on('error', () => undefined);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const pub = ssh2.utils.parseKey(hostKey);
  const fp = fingerprint((Array.isArray(pub) ? pub[0] : pub as ssh2.ParsedKey).getPublicSSH());
  return { port: (srv.address() as { port: number }).port, stats, fp, file, close: () => srv.close() };
}

const app = testApp();
after(() => ssh(app).closeAll());

test('the root password, once: fingerprint first, key added once, proven, password gone from everywhere', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'unit7-root-'));
  const mac = mkdtempSync(join(tmpdir(), 'unit7-mac-'));
  mkdirSync(join(mac, '.ssh'));
  const macPub = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'sam@laptop' }).public;
  writeFileSync(join(mac, '.ssh', 'id_ed25519.pub'), `${macPub}\n`);
  const realHome = process.env.HOME;
  process.env.HOME = mac;
  const logs: string[] = [];
  const keep = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ['log', 'error', 'warn'] as const) console[k] = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  const live: string[] = [];
  const off = app.events.on((e) => live.push(JSON.stringify(e)));
  const fake = await sshServer(home);
  try {
    assert.deepEqual(macKeys(), [macPub.trim()]);
    const o = await testOrg(app, 'Sam');
    const c = ok(await o.h('server.connect', { name: 'NewVps', host: '127.0.0.1', port: fake.port }));
    assert.equal(c.status, 'awaiting_key');

    // the identity, read without signing in
    const id1 = ok(await o.h('server.fingerprint', { serverId: c.serverId }));
    assert.deepEqual({ fp: id1.fingerprint, known: id1.known }, { fp: fake.fp, known: 'new' });
    assert.equal(fake.stats.passwords + fake.stats.keyLogins, 0, 'no sign-in to read it');

    const input = { serverId: c.serverId, password: PASSWORD, fingerprint: fake.fp };
    // an AI or a token never gets to use a password, even with the right one
    assert.equal((await o.a('server.install_key_with_password', input)).status, 'denied');
    assert.equal((await o.as({ kind: 'token', id: 'tok_1', userId: o.userId, name: 'Sam (token cli)', role: 'owner' })('server.install_key_with_password', input)).status, 'denied');
    // a server showing another identity never gets the password
    const wrongFp = await o.h('server.install_key_with_password', { ...input, fingerprint: `SHA256:${'A'.repeat(43)}` });
    assert.equal((wrongFp as any).error.code, 'host_key_changed');
    assert.equal(fake.stats.passwords, 0);

    const r = ok(await o.h('server.install_key_with_password', input));
    assert.equal(fake.stats.passwords, 1, 'one sign-in with the password');
    assert.deepEqual({ key: r.key, signedIn: r.signedIn, forgotten: r.passwordForgotten, mac: r.macKey, prepare: r.prepare }, { key: 'added', signedIn: true, forgotten: true, mac: 'added', prepare: 'checking' });
    assert.equal(r.suggest.tool, 'server.harden', 'passwords off is offered, now that this Mac’s key is there too');
    assert.ok(fake.stats.keyLogins >= 1, 'Unit7 proved its key works');
    const unit7Pub = json<{ publicKey: string }>(app.vault.list(o.orgId, `credential://ssh/newvps/private-key`)[0]!.meta, { publicKey: '' }).publicKey;
    const lines = readFileSync(fake.file, 'utf8').trim().split('\n');
    assert.equal(lines.filter((l) => l.includes(unit7Pub.split(' ')[1]!)).length, 1, 'Unit7’s key once');
    assert.equal(lines.filter((l) => l.includes(macPub.split(' ')[1]!)).length, 1, 'this Mac’s key once');
    assert.equal(statSync(fake.file).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, '.ssh')).mode & 0o777, 0o700);
    assert.equal(get<{ host_key: string }>(app.db, 'SELECT host_key FROM servers WHERE id = ?', c.serverId)!.host_key, fake.fp, 'pinned on first contact');
    assert.equal((await preparing.get(c.serverId))?.prepare, 'shared', 'then Unit7 looks inside: this one runs things');

    // the key works now: the password is refused as unneeded, and nothing is sent
    const again = await o.h('server.install_key_with_password', input);
    assert.equal((again as any).error.code, 'already_works');
    assert.equal(fake.stats.passwords, 1);

    // nowhere: no table, no event (stored or live), no log line
    for (const t of all<{ name: string }>(app.db, `SELECT name FROM sqlite_master WHERE type = 'table'`)) {
      const rows = JSON.stringify(all(app.db, `SELECT * FROM "${t.name}"`));
      assert.ok(!rows.includes(PASSWORD), `the password is in ${t.name}`);
    }
    assert.ok(!live.some((e) => e.includes(PASSWORD)), 'not in any event');
    assert.ok(!logs.some((l) => l.includes(PASSWORD)), 'not in any log');
    assert.ok(all<{ input: string }>(app.db, `SELECT input FROM audit WHERE tool = 'server.install_key_with_password'`).every((a) => a.input.includes('[sensitive]')));
  } finally {
    off(); Object.assign(console, keep); process.env.HOME = realHome; fake.close();
  }
});

test('three wrong passwords in 10 minutes and Unit7 stops trying; it never retries one by itself', { timeout: 60_000 }, async () => {
  const fake = await sshServer(mkdtempSync(join(tmpdir(), 'unit7-root-')));
  try {
    const o = await testOrg(app, 'Kim');
    const c = ok(await o.h('server.connect', { name: 'Guarded', host: '127.0.0.1', port: fake.port }));
    const tryIt = () => o.h('server.install_key_with_password', { serverId: c.serverId, password: 'not-the-password', fingerprint: fake.fp });
    for (let n = 1; n <= 3; n++) {
      assert.equal(((await tryIt()) as any).error.code, 'wrong_password');
      assert.equal(fake.stats.passwords, n, 'one try per press, never a retry');
    }
    const fourth = await tryIt();
    assert.equal((fourth as any).error.code, 'too_many_tries');
    assert.match((fourth as any).error.message, /Try again in 10 minutes/);
    assert.equal(fake.stats.passwords, 3, 'the fourth never reached the server');
  } finally { fake.close(); }
});

test('the key script is idempotent: no duplicates, a last line without a newline kept whole, keys matched by their body', async () => {
  const home = mkdtempSync(join(tmpdir(), 'unit7-keys-'));
  const k1 = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'unit7@box' }).public.trim();
  const k2 = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'sam@laptop' }).public.trim();
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'authorized_keys'), `${k2.replace('sam@laptop', 'old-comment')}`); // no final newline, another comment
  const runIt = () => new Promise<string>((resolve) => {
    const p = spawn('/bin/sh', ['-c', ADD_KEYS], { env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', () => resolve(out.trim()));
    p.stdin.end(`${k1}\n${k2}\n`);
  });
  assert.equal(await runIt(), 'added\npresent');
  assert.equal(await runIt(), 'present\npresent');
  const lines = readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.endsWith('old-comment') && lines[1] === k1);
});
