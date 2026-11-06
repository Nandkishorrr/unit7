// Unit7 Doctor: works out why a server is unreachable and fixes it through Hostinger's API.
// Hostinger is the mock MCP server (the scenario rides in the account token); the internet probe is
// off so tests run offline.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { testApp, testOrg, ok } from './helpers.ts';
import { hostinger } from '../src/connectors/hostinger.ts';
import { get, id, run } from '../src/db.ts';

process.env.UNIT7_HOSTINGER_CMD = process.execPath;
process.env.UNIT7_HOSTINGER_ARGS = fileURLToPath(new URL('./mock-mcp-server.mjs', import.meta.url));
process.env.UNIT7_SKIP_NET_PROBE = '1';

const app = testApp();
after(() => hostinger(app).closeAll());

// a server on a closed local port (so "reachable from this computer" is false), tied to a Hostinger
// account + VM so the provider branches run against the mock. `token` carries the scenario.
async function brokenServer(o: Awaited<ReturnType<typeof testOrg>>, token: string) {
  const acc = ok(await o.h('account.connect', { provider: 'hostinger', name: 'H', token }));
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, port, username, key_ref, account_id, provider_ref, status) VALUES (?, ?, 'box', '127.0.0.1', 59, 'root', 'credential://ssh/box/private-key', ?, 'hostinger:vm:1872799', 'ready')`, srv, o.orgId, acc.accountId);
  app.vault.put(o.orgId, 'credential://ssh/box/private-key', 'not a real key', { kind: 'ssh_key', meta: { publicKey: 'ssh-ed25519 AAAAexample unit7@box' } }); // Unit7 has its login key
  return srv;
}
const diag = async (o: Awaited<ReturnType<typeof testOrg>>, srv: string) => ok(await o.h('server.diagnose', { serverId: srv })) as any;

test('provider firewall blocking SSH → allow-ssh, and the fix applies', async () => {
  const o = await testOrg(app); const srv = await brokenServer(o, 'tok_fwblock_abcdef');
  const d = await diag(o, srv);
  assert.equal(d.cause, 'provider-wall');
  assert.equal(d.fixes[0].id, 'allow-ssh');
  assert.equal(ok(await o.h('server.repair', { serverId: srv, fix: 'allow-ssh' })).thenCheck, true);
});

test('powered off → start', async () => {
  const o = await testOrg(app); const srv = await brokenServer(o, 'tok_stopped_abcdef');
  assert.equal((await diag(o, srv)).cause, 'off');
});

test('unclear but a Hostinger VM → restart offered, with a manual command', async () => {
  const o = await testOrg(app); const srv = await brokenServer(o, 'tok_running_abcdef');
  const d = await diag(o, srv);
  assert.ok(['unknown', 'down'].includes(d.cause)); // no internet probe in tests
  assert.equal(d.fixes.find((f: any) => f.id === 'restart')?.id, 'restart');
  assert.ok(d.manual.command.includes('fail2ban'));
});

test('trust-host-key clears the pinned key and the stop, and only says fixed if signing in works', async () => {
  const o = await testOrg(app); const srv = await brokenServer(o, 'tok_running_abcdef');
  run(app.db, `UPDATE servers SET host_key = ?, ssh_block = 'host_key' WHERE id = ?`, 'SHA256:old', srv);
  assert.equal((await o.h('server.inspect', { serverId: srv }) as any).error.code, 'host_key_changed', 'stopped, not retried');
  const r = await o.h('server.repair', { serverId: srv, fix: 'trust-host-key' });
  assert.equal((r as any).error.code, 'not_fixed', 'the server is still down here, so not "fixed"');
  assert.deepEqual({ ...get<{ host_key: string | null; ssh_block: string | null }>(app.db, 'SELECT host_key, ssh_block FROM servers WHERE id = ?', srv) }, { host_key: null, ssh_block: null });
});

test('the do-it-yourself command never flushes the firewall (that takes Docker apps offline)', async () => {
  const o = await testOrg(app); const srv = await brokenServer(o, 'tok_running_abcdef');
  assert.doesNotMatch((await diag(o, srv)).manual.command, /iptables -F/);
});

test('no login key on this computer → "Add the login key" first, never a restart', async () => {
  const o = await testOrg(app);
  const acc = ok(await o.h('account.connect', { provider: 'hostinger', name: 'H', token: 'tok_stopped_abcdef' }));
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, port, username, key_ref, account_id, provider_ref, status) VALUES (?, ?, 'nokey', '127.0.0.1', 59, 'root', 'credential://ssh/nokey/private-key', ?, 'hostinger:vm:1872799', 'ready')`, srv, o.orgId, acc.accountId);
  const d = await diag(o, srv);
  assert.equal(d.cause, 'no-key');
  assert.deepEqual(d.fixes.map((f: { id: string; label: string }) => [f.id, f.label]), [['install-key', 'Add the login key']]);
});
