// Server care, proven with fakes. The shell scripts run for real in dash against a temporary folder (test/fake-box.ts), with
// stand-ins only for docker, iptables and useradd; the providers are stand-in APIs. Nothing here reaches a real server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account, type Req } from './clouds-fakes.ts';
import { makeBox, realShell, stubDir } from './fake-box.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';
import { get, id, json, run } from '../src/db.ts';
import { Unit7Error } from '../src/errors.ts';
import { ssh, type ServerRow } from '../src/connectors/ssh.ts';
import { hostinger, hostingerRisk } from '../src/connectors/hostinger.ts';
import { decideApproval, execute, getTool } from '../src/tools/runtime.ts';
import { colourOf } from '../src/policy.ts';
import { accessLeft, parseKeyLine, publicKeyLine, keyRemovalProblem, userRemovalProblem, parseAccess, userFromEmail, inviteMail } from '../src/tools/access.ts';
import { catalogPlans, fitOf, needOf, vpsTiming } from '../src/tools/vps.ts';
import { coversPort } from '../src/tools/hostinger.ts';
import { portRisk, BOOT_PORTS } from '../src/secure/ports.ts';
import { serverFindings } from '../src/tools/security.ts';
import { movesOf, parseSource, parseTarget, targetProblems } from '../src/tools/move.ts';
import { buildInventory } from '../src/discovery/xray.ts';
import { buyDeps } from '../src/fleet/care.ts';
import { freshness } from '../src/tools/servers.ts';
import type { App } from '../src/app.ts';

process.env.UNIT7_SKIP_NET_PROBE = '1';
vpsTiming.pollMs = 1; vpsTiming.waitMs = 200;
const apps: App[] = [];
after(() => { for (const a of apps) hostinger(a).closeAll(); });
const bin = stubDir();
const pair = (comment?: string) => ssh2.utils.generateKeyPairSync('ed25519', comment ? { comment } : {});
async function setup() {
  const app = testApp(); apps.push(app);
  const o = await testOrg(app);
  const server = (name: string, facts: object = {}, more: { ref?: string; acc?: string; host?: string } = {}) => {
    const sid = id('srv'), keys = pair(), ref = `credential://ssh/${name}/private-key`;
    app.vault.put(o.orgId, ref, keys.private, { kind: 'ssh_key', by: 'test' });
    run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts, provider_ref, account_id) VALUES (?, ?, ?, ?, 'root', ?, 'ready', ?, ?, ?)`, sid, o.orgId, name, more.host ?? '203.0.113.9', ref, JSON.stringify({ sudo: 'root', ...facts }), more.ref ?? null, more.acc ?? null);
    return { sid, own: keys.public };
  };
  return { app, o, server };
}
const row = (app: App, sid: string) => get<ServerRow>(app.db, 'SELECT * FROM servers WHERE id = ?', sid)!;
const factsOf = (app: App, sid: string) => json<any>(row(app, sid).facts, {});
const approve = async (app: App, o: Awaited<ReturnType<typeof testOrg>>, r: { approvalId?: string }, confirm?: string) => decideApproval(app, o.orgId, o.human, r.approvalId!, true, confirm);
const authorized = (root: string, ...keys: string[]) => writeFileSync(join(root, 'root/.ssh/authorized_keys'), `${keys.join('\n')}\n`);
const fpOf = (pub: string) => parseKeyLine(pub)!.fingerprint;

// --- reading keys --------------------------------------------------------------------------------------------------------
test('a key line is read the way sshd reads it, and its fingerprint is ssh-keygen’s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-keys-'));
  for (const t of ['ed25519', 'rsa', 'ecdsa']) {
    execFileSync('ssh-keygen', ['-q', '-t', t, '-N', '', '-C', `me@laptop ${t}`, '-f', join(dir, t)]);
    const line = readFileSync(join(dir, `${t}.pub`), 'utf8').trim(), k = parseKeyLine(line)!;
    const [, , fp, , kind] = /^(\d+) (SHA256:\S+) (.*) \((\S+)\)$/.exec(execFileSync('ssh-keygen', ['-lf', join(dir, `${t}.pub`)]).toString().trim())!;
    assert.equal(k.fingerprint, fp);
    assert.equal(k.comment, `me@laptop ${t}`);
    assert.equal(kind, { ed25519: 'ED25519', rsa: 'RSA', ecdsa: 'ECDSA' }[t]);
  }
  const k = pair('me').public;
  assert.equal(parseKeyLine(`no-pty,command="/bin/echo a b" ${k}`)?.forced, true, 'options first, quotes may hold spaces, and a forced command can’t give a shell');
  assert.equal(parseKeyLine(`from="203.0.113.0/24" ${k}`)?.forced, false);
  assert.equal(parseKeyLine(`# ${k}`), undefined);
  assert.equal(parseKeyLine('ssh-ed25519 AAAA'), undefined, 'a key too short to be one');
  assert.equal(parseKeyLine(`ssh-rsa ${k.split(' ')[1]}`), undefined, 'the blob says it’s another type');
  assert.throws(() => publicKeyLine('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'), /private key/);
  assert.throws(() => publicKeyLine(`${k}\n${pair().public}`), /single line/, 'two keys in one paste');
  assert.throws(() => publicKeyLine(`command="rm -rf /" ${k}`), /single line/, 'options don’t come in from outside');
  assert.equal(publicKeyLine(`${k.split(' ').slice(0, 2).join(' ')} sam $(reboot)`).line.endsWith(' sam reboot'), true, 'a comment can’t carry shell');
});

// what the probe prints: a file's own lines marked with =
const access = (out: string) => parseAccess(out.split('\n').map((l) => (l && !l.startsWith('@@') && !/^permitrootlogin/.test(l) ? `=${l}` : l)).join('\n'));
test('what never goes: Unit7’s key, the last key of a user, the last key a person has', () => {
  const [own, alice, bob, forced] = [pair(), pair(), pair(), pair()].map((k) => k.public);
  const blob = (k: string) => k!.split(' ')[1]!, key = (k: string) => parseKeyLine(k)!;
  const x = access(`@@sshd\npermitrootlogin prohibit-password\n@@user root:0:/bin/bash:/root:root\n${own}\n${alice}\n\n@@user deploy:1000:/bin/bash:/home/deploy:deploy sudo\n${bob}\n\n@@end\n`);
  assert.match(keyRemovalProblem(x, blob(own!), 'root', key(own!), 'box')!, /Unit7’s own key/);
  assert.match(keyRemovalProblem(x, blob(own!), 'deploy', key(bob!), 'box')!, /last key that works for deploy/);
  assert.equal(keyRemovalProblem(x, blob(own!), 'root', key(alice!), 'box'), undefined, 'bob still has a way in');
  const lone = access(`@@user root:0:/bin/bash:/root:root\n${own}\n${alice}\n\n@@end\n`);
  assert.match(keyRemovalProblem(lone, blob(own!), 'root', key(alice!), 'box')!, /last key a person can sign in/);
  // keys that can't really sign in don't count as a way in
  const nologin = access(`@@user root:0:/bin/bash:/root:root\n${own}\n${alice}\n\n@@user svc:1001:/usr/sbin/nologin:/home/svc:svc\n${bob}\n\n@@end\n`);
  assert.match(keyRemovalProblem(nologin, blob(own!), 'root', key(alice!), 'box')!, /last key a person/);
  const fixed = access(`@@user root:0:/bin/bash:/root:root\n${own}\n${alice}\ncommand="/bin/backup" ${forced}\n\n@@end\n`);
  assert.match(keyRemovalProblem(fixed, blob(own!), 'root', key(alice!), 'box')!, /last key a person/);
  const noRoot = access(`@@sshd\npermitrootlogin no\n@@user root:0:/bin/bash:/root:root\n${alice}\n\n@@user deploy:1000:/bin/bash:/home/deploy:deploy\n${own}\n${bob}\n\n@@end\n`);
  assert.match(keyRemovalProblem(noRoot, blob(own!), 'deploy', key(bob!), 'box')!, /last key a person/, 'root’s key is no way in when root can’t sign in');
  assert.match(userRemovalProblem(x, blob(own!), 'root', 'root', 'box')!, /system account|signs in/);
  assert.match(userRemovalProblem(noRoot, blob(own!), 'deploy', 'deploy', 'box')!, /signs in to box as deploy/);
  assert.match(userRemovalProblem(lone, blob(own!), 'nobody', 'root', 'box') ?? 'none', /none/, 'a user who isn’t there is no problem');
  const two = access(`@@user root:0:/bin/bash:/root:root\n${own}\n\n@@user sam:1000:/bin/bash:/home/sam:sam\n${alice}\n\n@@end\n`);
  assert.match(userRemovalProblem(two, blob(own!), 'sam', 'root', 'box')!, /last key a person/);
});

test('a line someone wrote in their own key file can’t pass for the probe’s marks', () => {
  const [own, alice, fake] = [pair(), pair(), pair()].map((k) => k.public);
  const x = parseAccess(`@@user root:0:/bin/bash:/root:root\n=${own}\n=${alice}\n@@user sam:1000:/bin/bash:/home/sam:sam\n=@@user ghost:1001:/bin/bash:/home/ghost:ghost\n=${fake}\n@@end\n`);
  assert.deepEqual(x.accounts.map((a) => a.user), ['root', 'sam'], 'no ghost account');
  assert.equal(x.accounts[1]!.keys.length, 1);
});

test('a key on a bought server: only Unit7’s there, so nothing a person holds is being protected', () => {
  const own = pair().public;
  assert.equal(userRemovalProblem(access(`@@user root:0:/bin/bash:/root:root\n${own}\n\n@@user sam:1000:/bin/bash:/home/sam:sam\n\n@@end\n`), own.split(' ')[1]!, 'sam', 'root', 'box'), undefined);
});

// --- keys and users on a real shell ---------------------------------------------------------------------------------------
async function keysWorld() {
  const w = await setup(), person = pair('ada@laptop').public, root = makeBox([{ name: 'deploy', uid: 1000 }]);
  const { sid, own } = w.server('box');
  authorized(root, own, person);
  const seen = realShell(w.app, { [sid]: root }, { bin });
  return { ...w, sid, own, person, root, seen };
}

test('an AI asking to add a key waits for a person; a person’s add writes one line, safely; the baseline knows it’s theirs', { timeout: 30_000 }, async () => {
  const { app, o, sid, own, person, root } = await keysWorld();
  assert.equal(ok(await o.h('security.hacked', { serverId: sid })).first, true, 'the first look is the baseline');
  const list = ok(await o.h('server.ssh_keys', { serverId: sid }));
  const rootKeys = list.accounts.find((a: any) => a.user === 'root').keys;
  assert.deepEqual(rootKeys.map((k: any) => k.unit7), [true, false], 'Unit7’s own key is marked');
  assert.ok(list.untrusted, 'comments are data');
  const sam = pair('sam@laptop').public;
  const asked = await o.a('server.ssh_keys', { serverId: sid, op: 'add', user: 'deploy', publicKey: sam });
  assert.equal(asked.status, 'approval_required', 'at any autonomy');
  assert.ok(!existsSync(join(root, 'home/deploy/.ssh/authorized_keys')), 'nothing changed before the yes');
  const done = await approve(app, o, asked as never, 'box') as any;
  assert.equal(done.status, 'ok');
  const file = join(root, 'home/deploy/.ssh/authorized_keys');
  assert.equal(readFileSync(file, 'utf8'), `${sam}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, 'home/deploy/.ssh')).mode & 0o777, 0o700);
  // again: no second line; and a file with no last newline stays two good lines
  assert.equal(ok(await o.h('server.ssh_keys', { serverId: sid, op: 'add', user: 'deploy', publicKey: sam })).already, true);
  writeFileSync(file, sam);
  ok(await o.h('server.ssh_keys', { serverId: sid, op: 'add', user: 'deploy', publicKey: person }));
  assert.equal(readFileSync(file, 'utf8'), `${sam}\n${person}\n`);
  const h = ok(await o.h('security.hacked', { serverId: sid }));
  assert.deepEqual(h.signs, [], 'a key a person added isn’t a break-in');
  const who = ok(await o.h('security.who', { serverId: sid }));
  assert.ok(who.servers[0].keys.every((k: any) => !k.fresh), 'nothing new');
  // a stranger's key, written behind Unit7's back, still shows, even after Unit7's own changes
  const stranger = pair('stranger').public;
  writeFileSync(file, `${readFileSync(file, 'utf8')}${stranger}\n`);
  ok(await o.h('server.ssh_keys', { serverId: sid, op: 'add', user: 'root', publicKey: sam }));
  const after = ok(await o.h('security.hacked', { serverId: sid }));
  assert.deepEqual(after.signs.map((s: any) => s.kind), ['new-key']);
  assert.ok(after.signs[0].what.includes(fpOf(stranger)));
  assert.ok(!own.includes('stranger'));
});

test('removing: never Unit7’s own key, never the last one that works, and an AI’s ask waits; the undo puts it back', { timeout: 30_000 }, async () => {
  const { app, o, sid, own, person, root } = await keysWorld();
  ok(await o.h('security.hacked', { serverId: sid }));
  const file = join(root, 'root/.ssh/authorized_keys'), before = readFileSync(file, 'utf8');
  const mine = await o.h('server.ssh_keys', { serverId: sid, op: 'remove', user: 'root', fingerprint: fpOf(own) });
  assert.equal(mine.status, 'error');
  assert.match((mine as any).error.message, /Unit7’s own key/);
  const last = await o.h('server.ssh_keys', { serverId: sid, op: 'remove', user: 'root', fingerprint: fpOf(person) });
  assert.equal(last.status, 'error');
  assert.match((last as any).error.message, /last key a person can sign in/);
  assert.equal(readFileSync(file, 'utf8'), before, 'the file wasn’t touched');
  // with a second person's key there, one can go: as an AI's ask, after a yes
  const sam = pair('sam').public;
  ok(await o.h('server.ssh_keys', { serverId: sid, op: 'add', user: 'root', publicKey: sam }));
  const asked = await o.a('server.ssh_keys', { serverId: sid, op: 'remove', user: 'root', fingerprint: fpOf(person) });
  assert.equal(asked.status, 'approval_required');
  const r = await approve(app, o, asked as never, 'box') as any;
  assert.equal(r.status, 'ok');
  const now = readFileSync(file, 'utf8');
  assert.ok(now.includes(own) && now.includes(sam) && !now.includes(person.split(' ')[1]!), 'exactly that key went');
  assert.deepEqual(readdirSync(join(root, 'root/.ssh')).sort(), ['authorized_keys'], 'nothing left beside it');
  assert.deepEqual(ok(await o.h('security.hacked', { serverId: sid })).signs, [], 'a removal is no sign either');
  ok(await o.h(r.output.undo.tool, r.output.undo.input));
  assert.ok(readFileSync(file, 'utf8').includes(person.split(' ')[1]!), 'undo puts it back');
  assert.deepEqual(ok(await o.h('security.hacked', { serverId: sid })).signs, []);
});

test('a link in place of authorized_keys is refused; a half-finished look changes nothing; only an owner or admin changes keys', { timeout: 30_000 }, async () => {
  const { app, o, sid, person, root, own } = await keysWorld();
  const home = join(root, 'home/deploy/.ssh');
  execFileSync('ln', ['-s', join(root, 'etc/passwd'), join(home, 'authorized_keys')]);
  const r = await o.h('server.ssh_keys', { serverId: sid, op: 'add', user: 'deploy', publicKey: person });
  assert.equal(r.status, 'error');
  assert.match((r as any).error.message, /is a link/);
  assert.ok(!readFileSync(join(root, 'etc/passwd'), 'utf8').includes('ssh-ed25519'), 'root didn’t write through the link');
  const dev = await execute(app, o.orgId, o.role('developer'), 'server.ssh_keys', { serverId: sid, op: 'add', publicKey: pair().public });
  assert.equal(dev.status, 'error');
  assert.match((dev as any).error.message, /Your role/);
  const realExec = ssh(app).exec;
  ssh(app).exec = async () => ({ code: 0, stdout: `@@user root:0:/bin/bash:/root:root\n${own}\n`, stderr: '', truncated: false });
  const cut = await o.h('server.ssh_keys', { serverId: sid, op: 'remove', user: 'root', fingerprint: fpOf(own) });
  assert.match((cut as any).error.message, /couldn’t read who can sign in/, 'half a list is no list');
  ssh(app).exec = realExec;
});

test('users: added with keys only, sudo a person’s choice, removed with their files kept; the guards hold and the baseline follows', { timeout: 30_000 }, async () => {
  const { app, o, sid, root, person } = await keysWorld();
  ok(await o.h('security.hacked', { serverId: sid }));
  const sam = pair('sam').public;
  assert.equal((await o.a('server.users', { serverId: sid, op: 'add', user: 'sam', publicKeys: [sam] })).status, 'approval_required');
  const added = ok(await o.h('server.users', { serverId: sid, op: 'add', user: 'sam', sudo: true, publicKeys: [sam] }));
  assert.equal(added.added, 'sam');
  assert.ok(readFileSync(join(root, 'etc/passwd'), 'utf8').includes('sam:x:'));
  assert.equal(readFileSync(join(root, 'home/sam/.ssh/authorized_keys'), 'utf8'), `${sam}\n`);
  assert.equal(readFileSync(join(root, 'etc/sudoers.d/unit7-sam'), 'utf8'), 'sam ALL=(ALL) NOPASSWD:ALL\n');
  assert.deepEqual(ok(await o.h('security.hacked', { serverId: sid })).signs, [], 'a user a person added isn’t a break-in');
  const who = ok(await o.h('security.who', { serverId: sid }));
  assert.ok(who.servers[0].users.some((u: any) => u.user === 'sam' && !u.fresh));
  for (const [user, why] of [['root', /system account|signs in/], ['daemon', /no user called/]] as const) {
    const r = await o.h('server.users', { serverId: sid, op: 'remove', user });
    assert.equal(r.status, 'error');
    assert.match((r as any).error.message, why);
  }
  assert.match(((await o.h('server.users', { serverId: sid, op: 'add', user: 'root' })) as any).error.message, /Pick another/);
  assert.match(((await o.h('server.users', { serverId: sid, op: 'add', user: 'daemon' })) as any).error.message, /Pick another/, 'never a system account');
  assert.match(JSON.stringify(await o.h('server.users', { serverId: sid, op: 'add', user: '../root' })), /Linux user name/, 'a name that could walk a path');
  writeFileSync(join(root, 'busy-sam'), '');
  assert.match(((await o.h('server.users', { serverId: sid, op: 'remove', user: 'sam' })) as any).error.message, /still runs programs/);
  rmSync(join(root, 'busy-sam'));
  const gone = ok(await o.h('server.users', { serverId: sid, op: 'remove', user: 'sam' }));
  assert.ok(!readFileSync(join(root, 'etc/passwd'), 'utf8').includes('sam:x:'));
  assert.ok(existsSync(join(root, 'home/sam')), 'their files stay');
  assert.ok(!existsSync(join(root, 'home/sam/.ssh/authorized_keys')), 'and a later sam doesn’t inherit the keys');
  assert.ok(!existsSync(join(root, 'etc/sudoers.d/unit7-sam')));
  assert.deepEqual(ok(await o.h('security.hacked', { serverId: sid })).signs, [], 'a removal isn’t a sign either');
  ok(await o.h(gone.undo.tool, gone.undo.input));
  assert.ok(readFileSync(join(root, 'home/sam/.ssh/authorized_keys'), 'utf8').includes(sam), 'undo puts them back, keys and all');
  assert.ok(person);
});

test('a server still only connected counts for security.who: Coolify servers stay that way', { timeout: 30_000 }, async () => {
  const { app, o, sid } = await keysWorld();
  run(app.db, `UPDATE servers SET status = 'connected' WHERE id = ?`, sid);
  assert.equal(ok(await o.h('security.who', {})).servers.length, 1);
});

// --- ports ---------------------------------------------------------------------------------------------------------------
async function portsWorld(o2: { docker?: boolean } = {}) {
  const w = await setup(), root = makeBox();
  const { sid } = w.server('box');
  if (o2.docker !== false) writeFileSync(join(root, 'chains'), 'docker\n');
  const seen = realShell(w.app, { [sid]: root }, { bin });
  return { ...w, sid, root, seen, rules: () => (existsSync(join(root, 'iptables.rules')) ? readFileSync(join(root, 'iptables.rules'), 'utf8') : '') };
}

test('opening a database port as an AI is refused outright; a person sees the warning; a plain port asks first, with its reason', { timeout: 30_000 }, async () => {
  const { app, o, sid, rules } = await portsWorld();
  for (const port of [5432, 3306, 6379, 27017, 2375, 8000, 2019]) {
    const r = await o.a('server.open_port', { serverId: sid, port, reason: 'the app needs it' });
    assert.equal(r.status, 'denied', `port ${port}`);
    assert.match((r as any).why, /Only a person/);
  }
  assert.equal(rules(), '', 'nothing changed');
  // the X-ray knows better than the number: a database on an unusual port
  run(app.db, `INSERT INTO xrays (id, org_id, server_id, kind, ok, data) VALUES (?, ?, ?, 'fast', 1, ?)`, id('xry'), o.orgId, sid, JSON.stringify({ parts: [{ id: 'c:db', kind: 'database', name: 'shop-db', ports: [{ port: 15432, proto: 'tcp', ip: '0.0.0.0', public: false }] }], ports: [] }));
  const odd = await o.a('server.open_port', { serverId: sid, port: 15432, reason: 'the app needs it' });
  assert.equal(odd.status, 'error');
  assert.match((odd as any).error.message, /shop-db, so only a person/);
  assert.match(JSON.stringify(await o.a('server.open_port', { serverId: sid, port: 8443, reason: 'x' })), /at least 5|too small|Too small/i, 'a reason, not a shrug');
  // a person gets the warning first
  const told = await o.h('server.open_port', { serverId: sid, port: 5432, reason: 'a report tool' });
  assert.equal(told.status, 'error');
  assert.match((told as any).error.message, /PostgreSQL database.*bots try passwords/);
  const plan = await o.h('server.open_port', { serverId: sid, port: 5432, reason: 'a report tool' }, { dryRun: true });
  assert.match((plan as any).plan.warning, /bots try passwords/);
  assert.equal(rules(), '');
  const yes = ok(await o.h('server.open_port', { serverId: sid, port: 5432, reason: 'a report tool', anyway: true }));
  assert.match(yes.warning, /bots try passwords/);
  assert.match(rules(), /unit7-open-5432/);
  // a plain port: an AI always asks, even at full autopilot
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  const asked = await o.a('server.open_port', { serverId: sid, port: 8443, reason: 'webhooks from a partner' });
  assert.equal(asked.status, 'approval_required');
  assert.match((asked as any).why, /a person decides.*webhooks from a partner/s);
  assert.doesNotMatch(rules(), /8443/);
  const done = await approve(app, o, asked as never) as any;
  assert.equal(done.status, 'ok');
  assert.match(rules(), /-A INPUT -i eth0 -p tcp --dport 8443 -m comment --comment unit7-open-8443 -j ACCEPT/);
  assert.match(rules(), /-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 8443 --ctdir ORIGINAL -m comment --comment unit7-open-8443 -j RETURN/);
  assert.equal(factsOf(app, sid).openedPorts['8443'].reason, 'webhooks from a partner');
  // an AI can't reopen one through the back door either
  const back = await o.a('server.close_port', { serverId: sid, port: 8443, open: true });
  assert.equal(back.status, 'denied');
  // SSH and web are simply open already
  assert.equal(ok(await o.h('server.open_port', { serverId: sid, port: 443, reason: 'for the sites' })).already, true);
});

test('rules survive a restart: closed and opened ports come back from the boot script, and undo leaves no trace', { timeout: 30_000 }, async () => {
  const { app, o, sid, root, rules } = await portsWorld();
  const closed = ok(await o.h('server.close_port', { serverId: sid, port: 7000 }));
  assert.equal(closed.survivesRestart, true);
  const opened = ok(await o.h('server.open_port', { serverId: sid, port: 8443, reason: 'webhooks from a partner' }));
  assert.equal(opened.survivesRestart, true);
  assert.deepEqual(readFileSync(join(root, 'etc/unit7/ports'), 'utf8').trim().split('\n'), ['close 7000', 'allow 8443']);
  assert.match(readFileSync(join(root, 'etc/systemd/system/unit7-ports.service'), 'utf8'), /After=docker\.service[\s\S]*ExecStart=\/bin\/sh \S*\/etc\/unit7\/ports\.sh[\s\S]*WantedBy=multi-user\.target/);
  assert.match(readFileSync(join(root, 'systemctl.log'), 'utf8'), /enable unit7-ports\.service/);
  const before = rules();
  rmSync(join(root, 'iptables.rules')); // the restart
  const box = (ssh(app).exec as any);
  const r = await box(row(app, sid), `sh /etc/unit7/ports.sh`);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(rules().split('\n').sort(), before.split('\n').sort(), 'every rule is back');
  const twice = await box(row(app, sid), `sh /etc/unit7/ports.sh`);
  assert.equal(twice.code, 0);
  assert.deepEqual(rules().split('\n').sort(), before.split('\n').sort(), 'and running it again adds nothing');
  ok(await o.h(opened.undo.tool, opened.undo.input));
  assert.doesNotMatch(rules(), /unit7-open-8443/);
  assert.match(rules(), /unit7-close-8443/, 'closing what was opened blocks it');
  ok(await o.h('server.close_port', { serverId: sid, port: 8443, open: true }));
  assert.doesNotMatch(rules(), /8443/);
  assert.equal(readFileSync(join(root, 'etc/unit7/ports'), 'utf8').trim(), 'close 7000', 'an open port leaves the list');
  assert.equal(factsOf(app, sid).openedPorts['8443'], undefined);
  assert.deepEqual(factsOf(app, sid).closedPorts, [7000]);
});

test('no systemd: the rule still works and the result says it won’t last; the boot script parses in dash', { timeout: 30_000 }, async () => {
  const { app, o, sid, rules } = await portsWorld();
  const realExec = ssh(app).exec;
  ssh(app).exec = async (s, c, x) => (c.includes('command -v systemctl') ? { code: 0, stdout: 'unsaved\n', stderr: '', truncated: false } : realExec.call(ssh(app), s, c, x));
  const r = ok(await o.h('server.close_port', { serverId: sid, port: 7000 }));
  assert.equal(r.survivesRestart, false);
  assert.match(rules(), /unit7-close-7000/);
  ssh(app).exec = realExec;
  const dir = mkdtempSync(join(tmpdir(), 'unit7-boot-'));
  writeFileSync(join(dir, 'ports.sh'), BOOT_PORTS);
  execFileSync('/bin/dash', ['-n', join(dir, 'ports.sh')]);
});

test('the weekly check sees an opened port, and says why it’s open', () => {
  const out = ['@@unit7 sshd', 'passwordauthentication no', '@@unit7 listen', '0.0.0.0:8443 users:(("api",pid=1,fd=3))', '@@unit7 ufw', 'Status: active', '@@unit7 iptables', '-A INPUT -i eth0 -p tcp --dport 8443 -m comment --comment unit7-open-8443 -j ACCEPT', '-A DOCKER-USER -i eth0 -j DROP', '@@unit7 docker', 'db|postgres:16|0.0.0.0:5432->5432/tcp', 'web|nginx|0.0.0.0:9000->80/tcp', '@@unit7 end'].join('\n');
  const f = serverFindings({ id: 'srv_x', name: 'box', port: 22, provider_ref: null }, { web: 'unit7-caddy|caddy:2', openedPorts: { 8443: { reason: 'webhooks', at: '2026-11-06T10:00:00Z' } } } as never, out).findings;
  const port = f.find((x) => x.id === 'server:port:srv_x:8443');
  assert.ok(port, 'ufw on, but Unit7’s own ACCEPT lets it through, so it’s reported');
  assert.match(port!.evidence!, /Opened on purpose on 2026-11-06: webhooks/);
  assert.ok(!f.some((x) => x.id === 'server:port:srv_x:5432'), 'the guard still hides what wasn’t opened');
});

test('which ports count as dangerous', () => {
  for (const p of [5432, 6379, 27017, 2375, 8000, 22]) assert.ok(portRisk(p), `port ${p}`);
  for (const p of [3000, 8443, 25565]) assert.equal(portRisk(p), undefined, `port ${p}`);
});

// --- Hostinger: snapshots and its firewall ------------------------------------------------------------------------------------
function fakeHostinger(app: App, st: { snapshot?: unknown; firewall?: unknown; catalog?: unknown; failGet?: string } = {}) {
  const calls: { op: string; params: any }[] = [];
  hostinger(app).call = (async (_c: unknown, _a: string, tool: string, args: any) => {
    if (tool === 'search') return '[]';
    calls.push({ op: args.operation, params: args.params });
    const out = (v: unknown) => JSON.stringify(v);
    switch (args.operation) {
      case 'vps_snapshots_get': if (st.failGet) throw new Unit7Error('hostinger_error', st.failGet, 502); if (!st.snapshot) throw new Unit7Error('hostinger_error', 'Hostinger said: not found', 502); return out({ data: st.snapshot });
      case 'vps_snapshots_create': st.snapshot = { id: 7, created_at: '2026-11-06T10:00:00Z' }; return out({ id: 1, state: 'initiated' });
      case 'vps_virtual-machines_list': return out({ data: [{ id: 42, hostname: 'big.example.com', state: 'running', plan: 'KVM 2', ipv4: [{ address: '203.0.113.9' }] }] });
      case 'vps_virtual-machines_get': return out({ data: { id: 42, firewall_group_id: st.firewall ? 5 : null } });
      case 'vps_firewall_get': return out({ data: st.firewall });
      case 'billing_catalog_list': return out({ data: st.catalog ?? [] });
      case 'vps_templates_list': return out({ data: [{ id: 3, name: 'Ubuntu 24.04 with Coolify' }, { id: 4, name: 'Ubuntu 24.04 64bit' }] });
      case 'vps_data-centers_list': return out({ data: [{ id: 9, name: 'nl', city: 'Amsterdam', continent: 'Europe' }] });
      default: return out({ ok: true });
    }
  }) as never;
  return calls;
}
async function hostingerWorld(st: Parameters<typeof fakeHostinger>[1] = {}) {
  const w = await setup(), acc = account(w.app, w.o.orgId, 'hostinger', 'hostinger-test-token');
  const { sid } = w.server('vps', {}, { ref: 'hostinger:vm:42', acc });
  return { ...w, sid, acc, calls: fakeHostinger(w.app, st) };
}

test('create is green and restore red; Hostinger’s one snapshot is never overwritten without a person', async () => {
  const t = getTool('server.snapshot')!;
  assert.equal((t.green as any)({ op: 'create', replace: false }), true);
  assert.equal((t.green as any)({ op: 'create', replace: true }), false, 'replacing changes something that exists');
  assert.equal((t.green as any)({ op: 'restore' }), false);
  assert.equal(colourOf((t.action as any)({ op: 'restore' }), (t.risk as any)({ op: 'restore' }), false), 'red');
  const { app, o, sid, calls } = await hostingerWorld();
  run(app.db, 'UPDATE orgs SET autonomy = 1 WHERE id = ?', o.orgId);
  assert.deepEqual(ok(await o.a('server.snapshot', { serverId: sid })).snapshots, [], 'none yet is an answer');
  const first = ok(await o.a('server.snapshot', { serverId: sid, op: 'create' }));
  assert.equal(first.started, true, 'by itself, at Recommend');
  assert.equal(calls.filter((c) => c.op === 'vps_snapshots_create').length, 1);
  // now there's one: a second would overwrite it
  const again = await o.a('server.snapshot', { serverId: sid, op: 'create' });
  assert.equal(again.status, 'error');
  assert.match((again as any).error.message, /keeps one snapshot per VPS.*replace it for good/);
  assert.equal(calls.filter((c) => c.op === 'vps_snapshots_create').length, 1, 'never overwritten');
  const replace = await o.a('server.snapshot', { serverId: sid, op: 'create', replace: true });
  assert.equal(replace.status, 'approval_required');
  assert.equal(calls.filter((c) => c.op === 'vps_snapshots_create').length, 1);
  ok(await approve(app, o, replace as never, 'vps') as never);
  assert.equal(calls.filter((c) => c.op === 'vps_snapshots_create').length, 2, 'after a person’s yes');
});

test('the raw route can’t overwrite Hostinger’s snapshot unasked either', async () => {
  assert.equal(hostingerRisk('vps_snapshots_create'), 'destructive');
  assert.equal(hostingerRisk('vps_snapshots_get'), 'read');
  const { o, sid, calls } = await hostingerWorld({ snapshot: { id: 7 } });
  assert.notEqual((await o.a('hostinger.do', { operation: 'vps_snapshots_create', params: { virtualMachineId: 42 } })).status, 'ok');
  assert.ok(!calls.some((c) => c.op === 'vps_snapshots_create') && sid);
});

test('a look that failed never overwrites: a create stops when Hostinger can’t say what’s there', async () => {
  const { o, sid, calls } = await hostingerWorld({ failGet: 'Hostinger said: 500 upstream' });
  assert.equal((await o.a('server.snapshot', { serverId: sid, op: 'create' })).status, 'error');
  assert.ok(!calls.some((c) => c.op === 'vps_snapshots_create'));
});

test('restore: an AI asks, a person approves by typing the name, and it’s only ever this server’s snapshot', async () => {
  const { app, o, sid, calls } = await hostingerWorld({ snapshot: { id: 7, created_at: '2026-11-01T09:00:00Z' } });
  const asked = await o.a('server.snapshot', { serverId: sid, op: 'restore' });
  assert.equal(asked.status, 'approval_required');
  assert.match((asked as any).why, /everything saved since then is lost/);
  const person = await o.h('server.snapshot', { serverId: sid, op: 'restore' });
  assert.equal(person.status, 'approval_required', 'red waits for a person’s explicit yes, even their own');
  assert.ok(!calls.some((c) => c.op === 'vps_snapshots_restore'));
  await assert.rejects(approve(app, o, person as never, 'wrong name'), /Type the name/);
  const r = await approve(app, o, person as never, 'vps') as any;
  assert.equal(r.status, 'ok');
  assert.match(r.output.note, /Everything saved after 2026-11-01 09:00 is gone/);
  assert.deepEqual(calls.at(-1), { op: 'vps_snapshots_restore', params: { virtualMachineId: 42 } });
});

test('Hostinger’s firewall: typed, synced, never the sign-in rule, and server.open_port opens it too', { timeout: 30_000 }, async () => {
  assert.ok(coversPort({ protocol: 'TCP', port: '1024:2048' }, 1500));
  assert.ok(coversPort({ protocol: 'SSH', port: '22' }, 22));
  assert.ok(!coversPort({ protocol: 'UDP', port: '8443' }, 8443));
  assert.ok(coversPort({ protocol: 'any', port: 'any' }, 8443));
  const fw = { id: 5, name: 'main', is_synced: true, rules: [{ id: 1, protocol: 'SSH', port: '22', source: 'any', source_detail: 'any' }, { id: 2, protocol: 'TCP', port: '9000', source: 'any', source_detail: 'any' }, { id: 3, protocol: 'TCP', port: '3000:3100', source: 'any', source_detail: 'any' }] };
  const { app, o, sid, calls } = await hostingerWorld({ firewall: fw });
  const list = ok(await o.a('hostinger.firewall', { serverId: sid }));
  assert.deepEqual(list.rules.map((r: any) => r.port), ['22', '9000', '3000:3100']);
  assert.equal((await o.a('hostinger.firewall', { serverId: sid, op: 'open', port: 5432 })).status, 'denied', 'a database port is a person’s');
  assert.equal((await o.a('hostinger.firewall', { serverId: sid, op: 'open', port: 8443 })).status, 'approval_required');
  assert.ok(!calls.some((c) => c.op === 'vps_firewall_create-rule'));
  const opened = ok(await o.h('hostinger.firewall', { serverId: sid, op: 'open', port: 8443 }));
  assert.deepEqual(calls.find((c) => c.op === 'vps_firewall_create-rule')!.params, { firewallId: 5, protocol: 'TCP', port: '8443', source: 'any', source_detail: 'any' });
  assert.ok(calls.some((c) => c.op === 'vps_firewall_sync-to-all-assigned-v-ms'), 'a rule does nothing until it’s synced');
  assert.equal(opened.undo.input.op, 'close');
  assert.equal(ok(await o.h('hostinger.firewall', { serverId: sid, op: 'open', port: 3050 })).already, true, 'a range already lets it in');
  assert.match(((await o.h('hostinger.firewall', { serverId: sid, op: 'close', port: 22 })) as any).error.message, /how you sign in/);
  ok(await o.h('hostinger.firewall', { serverId: sid, op: 'close', port: 9000 }));
  assert.deepEqual(calls.find((c) => c.op === 'vps_firewall_delete-rule')!.params, { firewallId: 5, ruleId: 2 });
  assert.match(ok(await o.h('hostinger.firewall', { serverId: sid, op: 'close', port: 3050 })).said, /wider rule/);
  // the server's own tool opens this one too
  const root = makeBox();
  realShell(app, { [sid]: root }, { bin });
  const r = ok(await o.h('server.open_port', { serverId: sid, port: 8500, reason: 'a partner’s webhook' }));
  assert.deepEqual(r.provider, { firewall: 'main', changed: true });
  assert.ok(calls.some((c) => c.op === 'vps_firewall_create-rule' && c.params.port === '8500'));
});

test('Hostinger’s firewall off: it says so; a failure at Hostinger doesn’t undo the server’s own rule', { timeout: 30_000 }, async () => {
  const { app, o, sid } = await hostingerWorld();
  assert.equal(ok(await o.a('hostinger.firewall', { serverId: sid })).on, false);
  const root = makeBox();
  realShell(app, { [sid]: root }, { bin });
  hostinger(app).call = (async () => { throw new Error('Hostinger said: down'); }) as never;
  const r = ok(await o.h('server.open_port', { serverId: sid, port: 8500, reason: 'a partner’s webhook' }));
  assert.match(r.provider.problem, /down/);
  assert.match(readFileSync(join(root, 'iptables.rules'), 'utf8'), /unit7-open-8500/);
});

// --- Hetzner and DigitalOcean ----------------------------------------------------------------------------------------------
const TYPES = [
  { name: 'cx11', cores: 1, memory: 2, disk: 20, architecture: 'x86', prices: [{ location: 'nbg1', price_monthly: { gross: '3.99' } }] },
  { name: 'cx22', cores: 2, memory: 4, disk: 40, architecture: 'x86', prices: [{ location: 'nbg1', price_monthly: { gross: '4.59' } }] },
  { name: 'cx32', cores: 4, memory: 8, disk: 80, architecture: 'x86', prices: [{ location: 'nbg1', price_monthly: { gross: '7.99' } }] },
  { name: 'cax11', cores: 2, memory: 4, disk: 40, architecture: 'arm', prices: [{ location: 'nbg1', price_monthly: { gross: '3.79' } }] },
];
async function hetznerWorld(o2: { failChange?: boolean; refuseWrites?: boolean } = {}) {
  const st = { status: 'running', type: 'cx22', log: [] as string[] };
  const api = await fakeApi(({ method, path, body }: Req) => {
    const p = path.split('?')[0]!;
    if (o2.refuseWrites && method !== 'GET') return [403, { error: { code: 'forbidden', message: 'insufficient permissions' } }];
    if (p === '/hz/images') return { images: [{ id: 501, description: 'mine', created: '2026-11-01T00:00:00Z', image_size: 3.2, created_from: { id: 77, name: 'box' } }, { id: 502, description: 'another server’s', created_from: { id: 88 } }], meta: {} };
    if (p === '/hz/server_types') return { server_types: TYPES, meta: {} };
    if (p === '/hz/servers' && method === 'GET') return { servers: [{ id: 77, name: 'box', status: st.status, public_net: { ipv4: { ip: '203.0.113.77' } } }], meta: {} };
    if (p === '/hz/servers/77' && method === 'GET') return { server: { id: 77, name: 'box', status: st.status, primary_disk_size: 40, server_type: TYPES.find((t) => t.name === st.type), datacenter: { location: { name: 'nbg1' } } } };
    if (p === '/hz/servers/77' && method === 'DELETE') { st.log.push('delete'); return { action: { id: 1 } }; }
    const a = /^\/hz\/servers\/77\/actions\/(\w+)$/.exec(p);
    if (a) {
      st.log.push(a[1]!);
      if (a[1] === 'shutdown' || a[1] === 'poweroff') st.status = 'off';
      if (a[1] === 'poweron') st.status = 'running';
      if (a[1] === 'change_type') { if (o2.failChange) return [409, { error: { message: 'server is locked' } }]; st.type = JSON.parse(body).server_type; }
      if (a[1] === 'create_image') return [201, { image: { id: 503, description: JSON.parse(body).description }, action: { id: 2 } }];
      if (a[1] === 'rebuild') return { action: { id: 3 }, root_password: 'do-not-show-me-please' };
      return { action: { id: 4 } };
    }
  });
  process.env.UNIT7_HETZNER_API = `${api.base}/hz`;
  const w = await setup(), acc = account(w.app, w.o.orgId, 'hetzner', 'hz-test-token');
  const { sid } = w.server('box', { cpus: 2, mem_total: 4 * 1024 ** 3, mem_available: 3 * 1024 ** 3, disk_total: 40e9, disk_used: 10e9 }, { ref: 'hetzner:server:77', acc });
  ssh(w.app).exec = async () => ({ code: 1, stdout: '', stderr: 'not here', truncated: false });
  return { ...w, sid, acc, api, st, done: () => { api.close(); delete process.env.UNIT7_HETZNER_API; } };
}

test('Hetzner snapshots: only this server’s, a person takes them because they’re billed, and no root password ever comes back', async () => {
  const { app, o, sid, api, st, done } = await hetznerWorld();
  try {
    const l = ok(await o.a('server.snapshot', { serverId: sid }));
    assert.deepEqual(l.snapshots.map((s: any) => s.id), ['501']);
    assert.match(l.billed, /bills snapshots by size/);
    const ai = await o.a('server.snapshot', { serverId: sid, op: 'create' });
    assert.equal(ai.status, 'error');
    assert.match((ai as any).error.message, /a person takes this one/);
    assert.ok(!st.log.includes('create_image'));
    const r = ok(await o.h('server.snapshot', { serverId: sid, op: 'create' }));
    assert.equal(r.started, true);
    const body = JSON.parse(api.calls.find((c) => c.path.endsWith('/create_image'))!.body);
    assert.equal(body.type, 'snapshot');
    const wrong = await o.h('server.snapshot', { serverId: sid, op: 'restore', snapshot: '502' });
    const bad = await approve(app, o, wrong as never, 'box') as any;
    assert.equal(bad.status, 'error');
    assert.match(bad.error.message, /no snapshot with that id/, 'another server’s image is refused');
    const asked = await o.h('server.snapshot', { serverId: sid, op: 'restore', snapshot: '501' });
    const out = await approve(app, o, asked as never, 'box') as any;
    assert.equal(out.status, 'ok');
    assert.deepEqual(JSON.parse(api.calls.find((c) => c.path.endsWith('/rebuild'))!.body), { image: 501 });
    assert.doesNotMatch(JSON.stringify(out), /do-not-show-me-please/);
  } finally { done(); }
});

test('a read-only Hetzner token gets a plain way forward', async () => {
  const { o, sid, done } = await hetznerWorld({ refuseWrites: true });
  try {
    const r = await o.h('server.power', { serverId: sid, op: 'off' });
    assert.match((r as any).error.message, /Read & Write token/);
  } finally { done(); }
});

test('a server connected by hand is found at its provider by address, and remembered', async () => {
  const { app, o, done, server, api } = await hetznerWorld();
  try {
    const { sid } = server('hand', {}, { host: '203.0.113.77' });
    assert.equal(ok(await o.a('server.snapshot', { serverId: sid })).provider, 'Hetzner');
    assert.equal(row(app, sid).provider_ref, 'hetzner:server:77');
    const nobody = server('nowhere', {}, { host: '203.0.113.200' }).sid;
    assert.match(((await o.a('server.snapshot', { serverId: nobody })) as any).error.message, /can’t tell which provider/);
    assert.ok(api.calls.length);
  } finally { done(); }
});

test('DigitalOcean snapshots go through its own API', async () => {
  const log: string[] = [];
  const api = await fakeApi(({ method, path, body }: Req) => {
    const p = path.split('?')[0]!;
    if (p === '/do/droplets/9/snapshots') return { snapshots: [{ id: 11, name: 'nightly', created_at: '2026-11-01', size_gigabytes: 2 }], links: {} };
    if (p === '/do/droplets/9/actions' && method === 'POST') { log.push(JSON.parse(body).type); return [201, { action: { id: 1, status: 'in-progress' } }]; }
  });
  process.env.UNIT7_DIGITALOCEAN_API = `${api.base}/do`;
  try {
    const w = await setup(), acc = account(w.app, w.o.orgId, 'digitalocean', 'dop_test');
    const { sid } = w.server('drop', {}, { ref: 'digitalocean:droplet:9', acc });
    assert.deepEqual(ok(await w.o.h('server.snapshot', { serverId: sid })).snapshots.map((s: any) => s.id), ['11']);
    assert.equal((await w.o.a('server.snapshot', { serverId: sid, op: 'create' })).status, 'error', 'billed, so a person’s');
    ok(await w.o.h('server.snapshot', { serverId: sid, op: 'create' }));
    const asked = await w.o.h('server.snapshot', { serverId: sid, op: 'restore', snapshot: '11' });
    ok(await approve(w.app, w.o, asked as never, 'drop') as never);
    assert.deepEqual(log, ['snapshot', 'restore']);
  } finally { api.close(); delete process.env.UNIT7_DIGITALOCEAN_API; }
});

test('what fits: real use with room to spare, a spike doesn’t count, and the catalog reads in plain numbers', () => {
  const n = needOf({ memPeak: 5 * 1024 ** 3, cpuBusy: 50, cpus: 4, diskUsed: 50 * 1024 ** 3, days: 7 });
  assert.deepEqual(n, { cores: 3, memoryGb: 6, diskGb: 60 });
  assert.deepEqual(fitOf({ cores: 4, memoryGb: 8, diskGb: 80 }, n), { fits: true });
  const small = fitOf({ cores: 2, memoryGb: 4, diskGb: 40 }, n);
  assert.equal(small.fits, false);
  assert.match(small.why!, /6 GB of memory.*60 GB of disk.*3 CPUs/);
  const plans = catalogPlans([
    { name: 'KVM 2', metadata: { cpus: '2', memory: '8192', disk_space: '102400' }, prices: [{ id: 'kvm2-24', price: 16776, period: 24, period_unit: 'month', currency: 'USD' }, { id: 'kvm2-1', price: 1399, period: 1, period_unit: 'month', currency: 'USD' }] },
    { name: 'domain', metadata: {}, prices: [] },
  ]);
  assert.deepEqual(plans, [{ plan: 'KVM 2', itemId: 'kvm2-1', cores: 2, memoryGb: 8, diskGb: 100, monthly: 13.99, currency: 'USD' }]);
});

test('resize: plans with what fits; an AI never changes one; a person’s yes turns it off, changes it, turns it on', { timeout: 30_000 }, async () => {
  const { app, o, sid, st, done } = await hetznerWorld();
  try {
    run(app.db, 'INSERT INTO metrics (server_id, at, cpu, mem_used, mem_total, disk_used, disk_total, load1, containers) VALUES (?, ?, 50, ?, ?, ?, ?, 1, ?)', sid, new Date(Date.now() - 3600_000).toISOString(), 3e9, 4e9, 10e9, 40e9, '[]');
    const r = ok(await o.a('server.resize', { serverId: sid }));
    assert.deepEqual(r.plans.map((p: any) => [p.plan, p.fits]), [['cx11', false], ['cx22', true], ['cx32', true]], 'same processor; too small says so');
    assert.ok(r.plans.find((p: any) => p.plan === 'cx22').current);
    assert.match(r.plans[0].why, /can’t make a 40 GB disk smaller/);
    assert.equal(r.how.tool, 'server.resize');
    const ai = await o.a('server.resize', { serverId: sid, plan: 'cx32' });
    assert.equal(ai.status, 'denied');
    assert.deepEqual(st.log, []);
    const asked = await o.h('server.resize', { serverId: sid, plan: 'cx32' });
    assert.equal(asked.status, 'approval_required');
    const out = await approve(app, o, asked as never, 'box') as any;
    assert.equal(out.status, 'ok');
    assert.deepEqual(st.log, ['shutdown', 'change_type', 'poweron']);
    assert.equal(st.type, 'cx32');
    assert.equal(st.status, 'running');
    assert.equal(get<{ monthly_price: number }>(app.db, 'SELECT monthly_price FROM servers WHERE id = ?', sid)!.monthly_price, 7.99, 'its price follows');
    const small = await o.h('server.resize', { serverId: sid, plan: 'cx11' });
    const no = await approve(app, o, small as never, 'box') as any;
    assert.match(no.error.message, /too small/);
    assert.deepEqual(st.log, ['shutdown', 'change_type', 'poweron'], 'nothing happened');
  } finally { done(); }
});

test('resize failing half way: the server doesn’t stay off', { timeout: 30_000 }, async () => {
  const { app, o, sid, st, done } = await hetznerWorld({ failChange: true });
  try {
    const asked = await o.h('server.resize', { serverId: sid, plan: 'cx32' });
    const r = await approve(app, o, asked as never, 'box') as any;
    assert.equal(r.status, 'error');
    assert.deepEqual(st.log, ['shutdown', 'change_type', 'poweron']);
    assert.equal(st.status, 'running');
  } finally { done(); }
});

test('resize on Hostinger gives the exact page and changes nothing', { timeout: 30_000 }, async () => {
  const catalog = [{ name: 'KVM 2', metadata: { cpus: '2', memory: '8192', disk_space: '102400' }, prices: [{ id: 'k2', price: 1399, period: 1, period_unit: 'month', currency: 'USD' }] }, { name: 'KVM 4', metadata: { cpus: '4', memory: '16384', disk_space: '204800' }, prices: [{ id: 'k4', price: 2599, period: 1, period_unit: 'month', currency: 'USD' }] }];
  const { app, o, sid, calls } = await hostingerWorld({ catalog });
  ssh(app).exec = async () => ({ code: 1, stdout: '', stderr: 'no', truncated: false });
  const r = ok(await o.a('server.resize', { serverId: sid }));
  assert.equal(r.how.page, 'https://hpanel.hostinger.com/vps/42/overview');
  assert.ok(r.plans.find((p: any) => p.plan === 'KVM 2').current);
  const asked = await o.h('server.resize', { serverId: sid, plan: 'KVM 4' });
  const out = await approve(app, o, asked as never, 'vps') as any;
  assert.equal(out.output.how, 'page');
  assert.ok(!calls.some((c) => /purchase|order/.test(c.op)), 'Unit7 never pays by itself');
});

// --- buying a first server ---------------------------------------------------------------------------------------------------
test('a first server: offers with no app, only a person buys, then it connects and prepares itself', { timeout: 60_000 }, async () => {
  const seen: { method: string; path: string; body: any }[] = [];
  const api = await fakeApi(({ method, path, body }: Req) => {
    const p = path.split('?')[0]!;
    seen.push({ method, path: p, body: body ? JSON.parse(body) : undefined });
    if (p === '/hz/server_types') return { server_types: [TYPES[1]] };
    if (p === '/hz/locations') return { locations: [{ name: 'nbg1', city: 'Nuremberg', country: 'DE' }] };
    if (p === '/hz/ssh_keys') return [201, { ssh_key: { id: 9 } }];
    if (p === '/hz/servers' && method === 'POST') return [201, { server: { id: 78 } }];
    if (p === '/hz/servers/78') return { server: { id: 78, status: 'running', public_net: { ipv4: { ip: '203.0.113.78' } } } };
  });
  process.env.UNIT7_HETZNER_API = `${api.base}/hz`;
  buyDeps.listening = async () => true;
  buyDeps.sleep = async () => undefined;
  try {
    const w = await setup(), { app, o } = w, acc = account(app, o.orgId, 'hetzner', 'hz-test-token');
    assert.match(ok(await (await setup()).o.a('server.offers', {})).next, /Connect Hostinger or Hetzner/);
    const offers = ok(await o.a('server.offers', {}));
    assert.deepEqual(offers.offers.map((x: any) => [x.plan, x.monthly, x.location]), [['cx22', 4.59, 'nbg1']], 'an AI may look');
    const input = { provider: 'hetzner', accountId: acc, plan: 'cx22', location: 'nbg1' };
    assert.equal((await o.a('server.buy', input)).status, 'denied', 'never an AI, not even with approval');
    assert.ok(!seen.some((x) => x.method === 'POST'));
    w.server('taken');
    const clash = await o.h('server.buy', { ...input, name: 'taken' });
    const told = await approve(app, o, clash as never) as any;
    assert.match(told.error.message, /already exists/);
    assert.ok(!seen.some((x) => x.method === 'POST'), 'found out before paying, not after');
    // what the box says it is: nothing there yet, so it prepares itself
    ssh(app).exec = async (_s, c, x = {}) => {
      const stdin = String(x.stdin ?? '');
      if (c.includes('os_id=')) return { code: 0, stdout: 'os=Ubuntu 24.04\ncpus=2\nmem_total=4000000000\nmem_available=3000000000\ndisk_total=40000000000\ndisk_used=1000000000\ndocker=27.0.1\nhas=ufw\nuser=root\nsudo=root\nports=22,\n', stderr: '', truncated: false };
      if (stdin.includes('s ctrs')) return { code: 0, stdout: '@@unit7:host\nos=Ubuntu\n@@unit7:ports\ntcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=700,fd=3))\n', stderr: '', truncated: false };
      return { code: 0, stdout: '', stderr: '', truncated: false };
    };
    const asked = await o.h('server.buy', input);
    assert.equal(asked.status, 'approval_required', 'it waits for the person’s explicit yes');
    assert.match((asked as any).why, /costs money every month/);
    assert.ok(!seen.some((x) => x.method === 'POST'));
    const r = await approve(app, o, asked as never) as any;
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.equal(r.output.bought, 'server-1');
    assert.equal(r.output.connected, true);
    assert.equal(r.output.status, 'ready', 'bought, connected and prepared, with no app in sight');
    const srv = get<any>(app.db, `SELECT * FROM servers WHERE provider_ref = 'hetzner:server:78'`);
    assert.equal(srv.host, '203.0.113.78');
    assert.equal(get<any>(app.db, `SELECT action FROM audit WHERE tool = 'server.buy' AND result = 'success'`).action, 'provider_purchase');
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE KEY/);
    assert.ok(freshness);
  } finally { api.close(); delete process.env.UNIT7_HETZNER_API; }
});

test('Hostinger’s first server: its catalog, a plain Ubuntu, its data center, and an id the gate lets through', async () => {
  const catalog = [{ name: 'KVM 1', metadata: { cpus: '1', memory: '4096', disk_space: '51200' }, prices: [{ id: 'hostingercom-vps-kvm1-usd-1m', price: 699, period: 1, period_unit: 'month', currency: 'USD' }] }];
  const { o, acc } = await hostingerWorld({ catalog });
  const r = ok(await o.h('server.offers', {}));
  assert.deepEqual(r.offers.map((x: any) => [x.plan, x.itemId, x.templateId, x.dataCenterId, x.monthly]), [['KVM 1', 'hostingercom-vps-kvm1-usd-1m', 4, 9, 6.99]], 'not the template with a panel in it');
  // anything named *Id must be a Unit7 id, so Hostinger's own goes by another name, here and in fleet.buy_server
  assert.equal((await o.h('server.buy', { provider: 'hostinger', accountId: acc, item: 'hostingercom-vps-kvm1-usd-1m', templateId: 4, dataCenterId: 9 })).status, 'approval_required');
});

// --- power and delete --------------------------------------------------------------------------------------------------------
test('Hetzner power: off is a person’s call, on comes back, and undo is the other one', async () => {
  const { app, o, sid, st, done } = await hetznerWorld();
  try {
    const asked = await o.a('server.power', { serverId: sid, op: 'off' });
    assert.equal(asked.status, 'approval_required');
    assert.deepEqual(st.log, []);
    const r = await approve(app, o, asked as never) as any;
    assert.equal(r.status, 'ok');
    assert.deepEqual(st.log, ['shutdown']);
    assert.match(r.output.note, /keeps billing/);
    ok(await o.h(r.output.undo.tool, r.output.undo.input));
    assert.deepEqual(st.log, ['shutdown', 'poweron']);
    ok(await o.h('server.power', { serverId: sid, op: 'off', force: true }));
    assert.equal(st.log.at(-1), 'poweroff');
  } finally { done(); }
});

test('delete: people only, the name typed, never with apps on it, and Hostinger has no such thing', async () => {
  const { app, o, sid, st, done } = await hetznerWorld();
  try {
    assert.equal((await o.a('server.delete', { serverId: sid, confirmName: 'box' })).status, 'denied');
    assert.match(((await o.h('server.delete', { serverId: sid, confirmName: 'nope' })) as any).error.message, /type its name/);
    const proj = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] }));
    const svc = id('svc');
    run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config, status) VALUES (?, ?, ?, ?, ?, 'shop', 'shop', 'app', '{}', 'healthy')`, svc, o.orgId, proj.projectId ?? proj.id, proj.environments[0].id, sid);
    assert.match(((await o.h('server.delete', { serverId: sid, confirmName: 'box' })) as any).error.message, /still runs apps/);
    assert.deepEqual(st.log, []);
    run(app.db, 'DELETE FROM services WHERE id = ?', svc);
    assert.equal(ok(await o.h('server.delete', { serverId: sid, confirmName: 'box' })).deleted, 'box');
    assert.deepEqual(st.log, ['delete']);
    assert.equal(get(app.db, 'SELECT 1 FROM servers WHERE id = ?', sid), undefined);
  } finally { done(); }
  const h = await hostingerWorld();
  const r = await h.o.h('server.delete', { serverId: h.sid, confirmName: 'vps' });
  assert.match((r as any).error.message, /no API to delete a VPS.*hpanel/s);
  assert.equal((await h.o.h('server.power', { serverId: h.sid, op: 'off' })).status, 'error');
});

// --- moving a whole Coolify server --------------------------------------------------------------------------------------------
const DUMP = `\\connect relay\nCOPY public.users (id, name) FROM stdin;\n1\ta\n2\tb\n3\tc\n\\.\nCOPY public.orders (id) FROM stdin;\n7\n\\.\nALTER ROLE app WITH LOGIN PASSWORD 'SCRAM-SHA-256$4096:abc';\n`;
const inv = () => buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' });
function seedOld(root: string) {
  mkdirSync(join(root, 'data/coolify/source'), { recursive: true });
  mkdirSync(join(root, 'data/coolify/ssh/keys'), { recursive: true });
  mkdirSync(join(root, 'data/coolify/proxy'), { recursive: true });
  writeFileSync(join(root, 'data/coolify/source/.env'), 'APP_KEY=base64:secretsecret\n');
  writeFileSync(join(root, 'data/coolify/source/docker-compose.yml'), 'services: {}\n');
  writeFileSync(join(root, 'data/coolify/ssh/keys/id.root@host.docker.internal'), 'private\n');
  writeFileSync(join(root, 'data/coolify/proxy/acme.json'), '{"certs":1}\n');
  const db = inv().parts.filter((p) => p.owner === 'coolify' && p.engine === 'postgres');
  const ctrs: Record<string, unknown> = {};
  for (const p of db) {
    const c = p.internals?.find((x) => /postgres/.test(x.image))?.name ?? p.containers![0]!, vol = (p.volumes?.[0] ?? `v:${c}-data`).replace(/^v:/, '');
    ctrs[c] = { image: 'postgres:16', mounts: [{ Type: 'volume', Name: vol, Source: vol, Destination: '/var/lib/postgresql/data' }] };
    writeFileSync(join(root, 'docker', `dump-${c}.sql`), DUMP);
    mkdirSync(join(root, 'docker/volumes', vol), { recursive: true });
    writeFileSync(join(root, 'docker/volumes', vol, 'PG_VERSION'), 'live data\n');
  }
  writeFileSync(join(root, 'docker/containers.json'), JSON.stringify(ctrs));
}
const treeHash = (dir: string) => createHash('sha256').update(execFileSync('/bin/sh', ['-c', `cd ${JSON.stringify(dir)} && find . -type f | LC_ALL=C sort | xargs -I{} shasum -a 256 "{}"`])).digest('hex');
// the fixture's Supabase, with its storage in a volume of its own
const XRAY = COOLIFY_HOST.replace(/("Name":"\/supabase-storage-shopsupa01"[\s\S]*?"Mounts":)\[\]/, '$1[{"Type":"volume","Name":"shopsupa01_storage","Destination":"/var/lib/storage"}]');
async function moveWorld(o2: { xray?: string } = {}) {
  const w = await setup(), oldRoot = makeBox(), newRoot = makeBox();
  const from = w.server('old', { arch: 'x86_64' }), to = w.server('new', { arch: 'x86_64' }, { host: '203.0.113.10' });
  seedOld(oldRoot);
  mkdirSync(join(oldRoot, 'docker/volumes/shopsupa01_storage/a/b'), { recursive: true });
  writeFileSync(join(oldRoot, 'docker/volumes/shopsupa01_storage/a/b/photo.jpg'), 'x'.repeat(4096));
  const coolifyKey = pair('coolify').public;
  writeFileSync(join(oldRoot, 'root/.ssh/authorized_keys'), `${from.own}\n${coolifyKey}\n`);
  writeFileSync(join(newRoot, 'root/.ssh/authorized_keys'), `${to.own}\n`);
  const seen = realShell(w.app, { [from.sid]: oldRoot, [to.sid]: newRoot }, { bin, xray: o2.xray ?? XRAY });
  return { ...w, from: from.sid, to: to.sid, oldRoot, newRoot, seen, coolifyKey };
}

test('the plan says what moves, how long, and what stays behind, and a busy new server is refused', () => {
  const i = inv(), containers = i.parts.flatMap((p) => p.internals?.filter((x) => /postgres/.test(x.image)).map((x) => x.name) ?? []);
  const source = parseSource(`size=2048\n${containers.map((c) => `@@mounts ${c}\n${JSON.stringify([{ Type: 'volume', Name: `${c}-data`, Source: 'x', Destination: '/var/lib/postgresql/data' }])}`).join('\n')}\n@@end\n`);
  const m = movesOf(i, source);
  assert.equal(m.coolifyBytes, 2048 * 1024);
  assert.ok(m.databases.some((d) => d.part.name === 'shop-supabase' && d.volume), 'Supabase’s database goes as a dump');
  assert.ok(m.databases.some((d) => d.part.id === 'c:coolify-db'), 'Coolify’s own database too');
  assert.ok(!m.databases.some((d) => d.part.engine === 'redis'));
  assert.ok(!m.volumes.some((v) => v.name === 'coolify-redis'), 'Coolify’s queue isn’t yesterday’s to replay');
  assert.ok(m.domains.includes('shop.example.com'));
  assert.ok(m.leftBehind.some((l) => /built images/.test(l)) && m.leftBehind.some((l) => /saved after the copy/.test(l)));
  assert.ok(m.minutes >= 2);
  // what a server says never decides what gets emptied over there
  const walk = parseSource(`size=1\n@@mounts relaydb01\n${JSON.stringify([{ Type: 'bind', Source: '/data/coolify/../../etc', Destination: '/var/lib/postgresql/data' }])}\n@@end\n`);
  assert.equal(movesOf(i, walk).databases.find((d) => d.container === 'relaydb01')!.spec, undefined, 'a path that walks out of Coolify’s folder isn’t a place');
  const named = parseSource(`size=1\n@@mounts relaydb01\n${JSON.stringify([{ Type: 'volume', Name: '../x', Source: 'x', Destination: '/var/lib/postgresql/data' }])}\n@@end\n`);
  assert.equal(movesOf(i, named).databases.find((d) => d.container === 'relaydb01')!.spec, undefined);
  assert.equal(movesOf(i, parseSource(`size=1\n@@mounts relaydb01\n${JSON.stringify([{ Type: 'bind', Source: '/data/coolify/databases/relaydb01/data', Destination: '/var/lib/postgresql/data' }])}\n@@end\n`)).skip.includes('databases/relaydb01/data'), true, 'a data folder inside Coolify’s own goes as a dump, not as files');
  const from = { id: 'srv_a', name: 'old', facts: '{"arch":"x86_64"}' } as ServerRow, to = { id: 'srv_b', name: 'new', facts: '{}' } as ServerRow;
  const t = parseTarget('arch=aarch64\ndocker=\nmark=\nfree=1000\n@@containers\nsome-app\nunit7-caddy\n@@volumes\ncoolify-db|\n@@end\n');
  const why = targetProblems(t, from, to, { ...m, volumes: [...m.volumes, { name: 'coolify-db', bytes: 5e9 }] }).join(' ');
  for (const w of [/no Docker/, /runs on x86_64 and new on aarch64/, /already runs 1 container \(some-app\)/, /already has data in coolify-db/, /needs about/]) assert.match(why, w);
  assert.deepEqual(targetProblems(parseTarget('arch=x86_64\ndocker=27\nmark=\nfree=99999999999999\n@@containers\nunit7-caddy\n@@volumes\n@@end\n'), from, to, m), [], 'Unit7’s own empty proxy is no reason to refuse');
  assert.match(targetProblems(parseTarget('arch=x86_64\ndocker=27\ncoolify=yes\nmark=srv_other\nfree=99999999999999\n@@containers\n@@volumes\n@@end\n'), from, to, m).join(' '), /already has a Coolify of its own/);
  assert.deepEqual(targetProblems(parseTarget('arch=x86_64\ndocker=27\ncoolify=yes\nmark=srv_a\nfree=99999999999999\n@@containers\n@@volumes\ncoolify-db|srv_a\n@@end\n'), from, to, m), [], 'its own earlier copy may be refreshed');
});

test('server.move copies Coolify’s data, volumes and databases, proves it, and leaves the old server exactly as it was', { timeout: 120_000 }, async () => {
  const { app, o, from, to, oldRoot, newRoot, seen } = await moveWorld();
  const asked = await o.a('server.move', { serverId: from, toServerId: to });
  assert.equal(asked.status, 'approval_required', 'every secret goes to another machine: an AI asks');
  assert.ok(!existsSync(join(newRoot, 'data/coolify')));
  const before = treeHash(join(oldRoot, 'docker/volumes')) + treeHash(join(oldRoot, 'data/coolify'));
  const plan = ok(await o.h('server.move_plan', { serverId: from, toServerId: to }));
  assert.equal(plan.ready, true);
  assert.ok(plan.moves.databases.length >= 5 && plan.then.some((s: any) => s.tool === 'server.move_start'));
  const r = await approve(app, o, asked as never) as any;
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 600));
  const out = r.output;
  assert.equal(out.proven, true, JSON.stringify(out.problems));
  // a volume, whole
  assert.deepEqual(out.proof.volumes.find((v: any) => v.name === 'shopsupa01_storage'), { name: 'shopsupa01_storage', files: 1, arrived: 1, ok: true });
  assert.equal(readFileSync(join(newRoot, 'docker/volumes/shopsupa01_storage/a/b/photo.jpg'), 'utf8').length, 4096);
  // the files, byte for byte
  assert.equal(readFileSync(join(newRoot, 'data/coolify/source/.env'), 'utf8'), 'APP_KEY=base64:secretsecret\n');
  assert.equal(readFileSync(join(newRoot, 'data/coolify/proxy/acme.json'), 'utf8'), '{"certs":1}\n');
  // a database arrives as its dump, loaded into its own volume, with its own passwords back last
  const db = out.proof.databases[0];
  assert.match(db.note, /all 2 tables and 4 rows came back/);
  const vol = readdirSync(join(newRoot, 'docker/volumes'));
  const loaded = readFileSync(join(newRoot, 'docker/volumes', vol.find((v) => /relaydb01/.test(v))!, 'loaded.sql'), 'utf8');
  assert.ok(loaded.includes('COPY public.users') && loaded.trimEnd().endsWith(`ALTER ROLE app WITH LOGIN PASSWORD 'SCRAM-SHA-256$4096:abc';`), 'the apps’ passwords are the last word');
  assert.ok(!readdirSync(join(newRoot, 'docker/volumes', vol.find((v) => /relaydb01/.test(v))!)).includes('PG_VERSION'), 'not a live file copy');
  assert.equal(JSON.parse(readFileSync(join(newRoot, 'docker/containers.json'), 'utf8')) && Object.keys(JSON.parse(readFileSync(join(newRoot, 'docker/containers.json'), 'utf8'))).length, 0, 'no test copy left running');
  // the old server: nothing changed, nothing stopped
  assert.equal(treeHash(join(oldRoot, 'docker/volumes')) + treeHash(join(oldRoot, 'data/coolify')), before);
  const onOld = seen.filter((c) => c.server === 'old').map((c) => c.command).join('\n');
  assert.doesNotMatch(onOld, /docker (stop|rm|restart|kill|compose)|find "\$1" -mindepth|volume create|-delete/);
  assert.ok(existsSync(join(oldRoot, 'var/backups/unit7')), 'the one new thing there: a fresh backup');
  assert.equal(factsOf(app, from).move.proven, true);
  assert.equal(factsOf(app, from).move.to, to);
  assert.ok(out.then.some((s: any) => s.tool === 'domain.point' && s.input.hostname === 'shop.example.com' && s.input.server.serverId === to));
  // every step names a tool that exists, with an input it takes, so a person can run them one at a time
  for (const s of out.then) { assert.ok(getTool(s.tool), s.tool); if (s.input) assert.equal(getTool(s.tool)!.input.safeParse(s.input).success, true, s.tool); }
  assert.doesNotMatch(JSON.stringify(out), /secretsecret/);
});

test('a copy that doesn’t check out says so, and can’t be started', { timeout: 120_000 }, async () => {
  const { app, o, from, to, newRoot } = await moveWorld();
  writeFileSync(join(newRoot, 'docker/lose-rows'), '');
  const out = ok(await o.h('server.move', { serverId: from, toServerId: to }));
  assert.equal(out.proven, false);
  assert.match(out.problems.join(' '), /came back short.*public\.users \(2 of 3 rows\)/);
  const start = await o.h('server.move_start', { serverId: from, toServerId: to });
  assert.match((start as any).error.message, /didn’t check out/);
  assert.ok(!existsSync(join(newRoot, 'docker/compose.log')), 'nothing started');
  assert.equal(factsOf(app, from).move.proven, false);
});

test('a volume cut off half way stops the copy; running it again replaces its own copy and nothing else', { timeout: 120_000 }, async () => {
  const { app, o, from, to, newRoot, oldRoot } = await moveWorld();
  const relay = ssh(app).relay;
  let cut = true;
  ssh(app).relay = async (a, b, c, d, x) => { if (cut && b.includes('alpine:3')) { cut = false; throw new Unit7Error('transfer_failed', 'the connection dropped', 502); } return relay.call(ssh(app), a, b, c, d, x); };
  const r = await o.h('server.move', { serverId: from, toServerId: to });
  assert.equal(r.status, 'error');
  assert.match((r as any).error.message, /connection dropped/);
  assert.equal(factsOf(app, from).move, undefined, 'no copy is claimed');
  writeFileSync(join(newRoot, 'data/coolify/left-over.txt'), 'from the cut run\n');
  writeFileSync(join(oldRoot, 'data/coolify/source/new-setting'), 'y\n');
  assert.equal(ok(await o.h('server.move', { serverId: from, toServerId: to })).proven, true);
  assert.ok(!existsSync(join(newRoot, 'data/coolify/left-over.txt')), 'its own earlier copy is replaced whole');
  assert.ok(existsSync(join(newRoot, 'data/coolify/source/new-setting')));
});

test('a volume that changed while it was copied isn’t called proven', { timeout: 120_000 }, async () => {
  const { app, o, from, to, newRoot } = await moveWorld();
  const relay = ssh(app).relay;
  ssh(app).relay = async (a, b, c, d, x) => { await relay.call(ssh(app), a, b, c, d, x); if (b.includes('alpine:3')) writeFileSync(join(newRoot, 'docker/volumes/shopsupa01_storage/extra'), 'y'); };
  const out = ok(await o.h('server.move', { serverId: from, toServerId: to }));
  assert.equal(out.proven, false);
  assert.match(out.problems.join(' '), /shopsupa01_storage differs: 1 files here, 2 there.*stop it and run this again/);
});

test('a new server that isn’t empty is refused before anything moves, and fleet still refuses Coolify servers', { timeout: 120_000 }, async () => {
  const { app, o, from, to, newRoot, seen } = await moveWorld();
  writeFileSync(join(newRoot, 'docker/containers.json'), JSON.stringify({ blog: { image: 'ghost', mounts: [] } }));
  const r = await o.h('server.move', { serverId: from, toServerId: to });
  assert.equal(r.status, 'error');
  assert.match((r as any).error.message, /didn’t copy anything.*already runs 1 container/);
  assert.ok(!seen.some((c) => c.command.includes('tar')), 'not one byte');
  assert.match(((await o.h('server.move', { serverId: from, toServerId: from })) as any).error.message, /another server/);
  run(app.db, `UPDATE servers SET facts = json_set(facts, '$.web', 'coolify-proxy|traefik:v3') WHERE id = ?`, from);
  const proj = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] })), svc = id('svc'), dep = id('dep');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config, status, current_deployment_id) VALUES (?, ?, ?, ?, ?, 'shop', 'shop', 'app', '{}', 'healthy', ?)`, svc, o.orgId, proj.projectId ?? proj.id, proj.environments[0].id, from, dep);
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status) VALUES (?, ?, ?, 1, 'live')`, dep, o.orgId, svc);
  const fleet = await o.h('fleet.add_server', { serviceId: svc, serverId: to });
  assert.match((fleet as any).error.message, /Coolify’s proxy/, 'a move isn’t a second server serving visitors');
});

test('the first step of the switch is a person’s: Coolify starts on the same version, with its key, and the apps stay stopped', { timeout: 120_000 }, async () => {
  const { app, o, from, to, oldRoot, newRoot, coolifyKey } = await moveWorld();
  assert.equal((await o.h('server.move_start', { serverId: from, toServerId: to })).status, 'error', 'no copy yet');
  ok(await o.h('server.move', { serverId: from, toServerId: to }));
  assert.equal((await o.a('server.move_start', { serverId: from, toServerId: to })).status, 'denied');
  ok(await o.h('security.hacked', { serverId: to }));
  const r = ok(await o.h('server.move_start', { serverId: from, toServerId: to }));
  assert.equal(r.started, true);
  assert.match(readFileSync(join(newRoot, 'docker/compose.log'), 'utf8'), /^4\.4\.0 --env-file \.env -f docker-compose\.yml -f docker-compose\.prod\.yml up -d/);
  assert.ok(readFileSync(join(newRoot, 'root/.ssh/authorized_keys'), 'utf8').includes(coolifyKey.split(' ')[1]!), 'Coolify can reach its new home');
  assert.deepEqual(ok(await o.h('security.hacked', { serverId: to })).signs, [], 'its key isn’t a break-in');
  assert.ok(!existsSync(join(oldRoot, 'docker/compose.log')), 'nothing happened on the old one');
  assert.match(((await o.h('server.move', { serverId: from, toServerId: to })) as any).error.message, /already runs on new/, 'and the copy can’t be overwritten now');
  assert.ok(factsOf(app, from).move.started);
});

// --- teammates --------------------------------------------------------------------------------------------------------------
test('an invite can bring real access: their own user and key on the servers chosen; an AI can’t; leaving the team says what’s left', { timeout: 30_000 }, async () => {
  assert.equal(userFromEmail('Sam.Jones@acme.example'), 'samjones');
  assert.match(userFromEmail('root@acme.example'), /^team-/);
  assert.match(userFromEmail('1234@acme.example'), /^team-/);
  const { app, o, server, sid, root } = await keysWorld();
  const two = server('down');
  const realExec = ssh(app).exec;
  ssh(app).exec = async (s, c, x) => { if (s.id === two.sid) throw new Unit7Error('unreachable', 'down did not answer.', 502); return realExec.call(ssh(app), s, c, x); };
  const key = pair('sam').public;
  ok(await o.h('security.hacked', { serverId: sid }));
  assert.equal((await o.a('team.give_access', { email: 'sam@acme.example', publicKey: key, servers: [sid] })).status, 'denied');
  const r = ok(await o.h('team.give_access', { email: 'sam@acme.example', publicKey: key, servers: [sid, two.sid] }));
  assert.equal(r.user, 'sam');
  assert.deepEqual(r.servers.map((s: any) => [s.server, s.ok]), [['box', true], ['down', false]], 'each server says how it went');
  assert.equal(readFileSync(join(root, 'home/sam/.ssh/authorized_keys'), 'utf8'), `${key}\n`.replace(' sam\n', ' sam\n'));
  assert.equal(factsOf(app, sid).team[0].email, 'sam@acme.example');
  const who = ok(await o.h('security.who', { serverId: sid }));
  assert.equal(who.servers[0].keys.find((k: any) => k.teammate)?.teammate, 'sam@acme.example');
  assert.ok(who.servers[0].keys.every((k: any) => !k.fresh));
  assert.deepEqual(accessLeft(app.db, o.orgId, 'SAM@acme.example'), [{ serverId: sid, server: 'box', user: 'sam' }], 'leaving the team says where they can still sign in');
  assert.deepEqual(accessLeft(app.db, o.orgId, 'other@acme.example'), []);
});

test('an emailed invite only with a sender connected, and the link stays out of the audit', async () => {
  const { app, o } = await setup();
  const link = 'https://unit7.example/invite/abc123', input = { email: 'sam@acme.example', link };
  assert.equal((await o.a('team.email_invite', input)).status, 'denied');
  assert.match(((await o.h('team.email_invite', input)) as any).error.message, /No email sender is connected.*Copy the link/);
  const sent: any[] = [];
  inviteMail.send = async (_c, _a, args) => { sent.push(args); };
  account(app, o.orgId, 'resend', 'x');
  assert.equal(ok(await o.h('team.email_invite', { ...input, from: 'team@acme.example' })).emailed, 'sam@acme.example');
  assert.equal(sent[0].to, 'sam@acme.example');
  assert.match(sent[0].text, /invite\/abc123/);
  assert.equal(sent[0].from, 'team@acme.example');
  assert.doesNotMatch(get<{ input: string }>(app.db, `SELECT input FROM audit WHERE tool = 'team.email_invite' AND result = 'success'`)!.input, /abc123/);
  assert.match(JSON.stringify(await o.h('team.email_invite', { email: 'sam@acme.example', link: 'https://evil.example/phish' })), /an invite link/);
});
