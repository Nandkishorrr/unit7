// Real SSH + Docker against a disposable server container. Skipped when Docker isn't available.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { dockerAvailable, startServer } from './fixture.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { script, cmd, shq } from '../src/connectors/shell.ts';
import { serverRow } from '../src/tools/servers.ts';
import { classify } from '../src/netguard.ts';
import { get, run } from '../src/db.ts';
import { decideApproval } from '../src/tools/runtime.ts';

const skip = !dockerAvailable() && 'Docker is not available';
let fx: Awaited<ReturnType<typeof startServer>>;
const app = testApp();
let o: Awaited<ReturnType<typeof testOrg>>;
let serverId: string;

before(async () => {
  if (skip) return;
  fx = await startServer();
  o = await testOrg(app);
}, { timeout: 180_000 });
after(() => { ssh(app).closeAll(); fx?.stop(); });

test('shell quoting: hostile values stay values', { skip }, async () => {
  assert.equal(shq("it's"), `'it'\\''s'`);
  assert.throws(() => cmd('rm -rf /'));
  const r = ok(await o.h('server.connect', { name: 'Fixture', host: '127.0.0.1', port: fx.sshPort, privateKey: fx.privateKey }));
  serverId = r.serverId;
  assert.match(r.hostKey, /^SHA256:/);
  const s = serverRow({ db: app.db, orgId: o.orgId }, serverId);
  for (const evil of ["a'; echo PWNED; '", '$(echo PWNED)', '`echo PWNED`', 'x\n echo PWNED', '; touch /tmp/pwned']) {
    const out = await ssh(app).check(s, script('printf %s "$1"', evil));
    assert.equal(out, evil);
  }
  assert.equal((await ssh(app).exec(s, 'test -e /tmp/pwned')).code, 1);
});

test('connect pins the host key and inspects the machine', { skip }, async () => {
  const facts = ok(await o.h('server.inspect', { serverId }));
  assert.ok(facts.docker, 'docker version detected');
  assert.ok(facts.cpus > 0);
  assert.equal(facts.user, 'root');
  // a different host key must be refused
  run(app.db, `UPDATE servers SET host_key = 'SHA256:not-the-real-key' WHERE id = ?`, serverId);
  ssh(app).close(serverId);
  const refused = await o.h('server.inspect', { serverId });
  assert.equal(refused.status, 'error');
  assert.match((refused as any).error.message, /host key changed/);
  // agents can't re-trust; people can
  assert.notEqual((await o.a('server.trust_host_key', { serverId })).status, 'ok');
  ok(await o.h('server.trust_host_key', { serverId }));
  ok(await o.h('server.inspect', { serverId }));
  assert.match(get<{ host_key: string }>(app.db, 'SELECT host_key FROM servers WHERE id = ?', serverId)!.host_key, /^SHA256:/);
});

test('bootstrap prepares the server and is idempotent', { skip, timeout: 600_000 }, async () => {
  const r = ok(await o.h('server.bootstrap', { serverId }));
  assert.equal(r.status, 'ready');
  assert.ok(r.steps.some((s: string) => /Docker .* already installed/.test(s)));
  assert.ok(r.proxy?.startsWith('Up'));
  const again = ok(await o.h('server.bootstrap', { serverId }));
  assert.ok(again.steps.includes('Caddy is already running.'));
  // Caddy answers on port 80 through the fixture (no sites yet → empty 200 or 404, but a response)
  const res = await fetch(`http://127.0.0.1:${fx.httpPort}/`, { headers: { host: 'unknown.example' } }).catch((e) => e);
  assert.ok(res instanceof Response, `Caddy did not answer: ${res}`);
  assert.equal(res.status, 421);
  const containers = ok<any[]>(await o.h('docker.list', { serverId }));
  assert.ok(containers.some((c) => c.Names === 'unit7-caddy'));
});

test('metrics, processes and logs', { skip }, async () => {
  const m = ok(await o.h('server.metrics', { serverId }));
  assert.ok(m.now.memTotal > 0 && m.now.diskTotal > 0);
  assert.ok(m.now.cpu >= 0 && m.now.cpu <= 100);
  assert.ok(m.now.containers.some((c: any) => c.name === 'unit7-caddy'));
  const ps = ok<any[]>(await o.h('server.processes', { serverId, sortBy: 'mem', limit: 5 }));
  assert.ok(ps.length > 0 && ps[0].pid > 0);
  const logs = ok(await o.h('docker.logs', { serverId, container: 'unit7-caddy', lines: 20 }));
  assert.ok(Array.isArray(logs.lines));
  assert.equal((await o.h('docker.logs', { serverId, container: 'x; rm -rf /' })).status, 'error');
});

test('server.exec is gated for agents and redacts output', { skip }, async () => {
  const r = await o.a('server.exec', { serverId, command: 'echo hi' });
  assert.equal(r.status, 'approval_required'); // org-wide resources: server_exec is restricted
  // restricted means people confirm too: the owner's request waits, then runs once approved
  const pending = await o.h('server.exec', { serverId, command: 'echo postgres://app:hunter22@db/x' });
  assert.equal(pending.status, 'approval_required');
  const done = await decideApproval(app, o.orgId, o.human, (pending as any).approvalId, true);
  assert.match(ok(done as any).stdout, /postgres:\/\/app:\[redacted\]@db/);
});

test('netguard: metadata endpoints are never reachable', () => {
  assert.equal(classify('169.254.169.254'), 'metadata');
  assert.equal(classify('10.0.0.5'), 'private');
  assert.equal(classify('8.8.8.8'), 'public');
  assert.equal(classify('::ffff:169.254.169.254'), 'metadata');
});

test('a fresh key is never tried until a person says it’s there; "check again" signs in once and reports honestly', { skip, timeout: 120_000 }, async () => {
  const c = ok(await o.h('server.connect', { name: 'NoKey', host: '127.0.0.1', port: fx.sshPort })); // Unit7 makes a key the server doesn't know
  const t0 = Date.now();
  assert.equal((await o.h('server.inspect', { serverId: c.serverId }) as any).error.code, 'key_refused');
  assert.ok(Date.now() - t0 < 1000, 'answered without signing in');
  const d = ok(await o.h('server.diagnose', { serverId: c.serverId }));
  assert.equal(d.cause, 'key');
  assert.ok(d.manual.command.includes(c.publicKey.trim().split(' ')[1]), 'the exact key to add');
  assert.equal((await o.h('server.repair', { serverId: c.serverId, fix: 'check-key' }) as any).error.code, 'still_refused', 'one real try, refused, said plainly');
  assert.equal(ssh(app).keyRefused(c.serverId), true, 'and Unit7 stops again');
  // the key goes on the server (what install-key or the command does): now "check again" fixes it
  await ssh(app).exec(serverRow({ db: app.db, orgId: o.orgId } as never, serverId), script('printf "%s\\n" "$1" >> ~/.ssh/authorized_keys', c.publicKey.trim()));
  ok(await o.h('server.repair', { serverId: c.serverId, fix: 'check-key' }));
  assert.equal(ssh(app).keyRefused(c.serverId), false);
  ok(await o.h('server.inspect', { serverId: c.serverId }));
});
