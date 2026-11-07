// Found by an outside review of the code: small, each with its own way back in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { testApp, testOrg } from './helpers.ts';
import { get, id, run } from '../src/db.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { assertReachable, classify } from '../src/netguard.ts';
import { createHttp } from '../src/server/http.ts';
import { createToken } from '../src/auth.ts';
import { closeInterrupted, drainTools } from '../src/tools/runtime.ts';

test('the network guard goes by the address, however it’s written', async () => {
  const same: Record<string, string[]> = {
    loopback: ['::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '127.0.0.1'],
    metadata: ['169.254.169.254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:a9fe:a9fe', 'fd00:ec2::254', 'fd00:ec2:0:0:0:0:0:254', 'fe80::1', 'fe90::1', 'febf::1', 'FE80::1'],
    private: ['10.0.0.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', 'fc00::1', 'fd12::1', '0:0:0:0:0:ffff:a00:1'],
    invalid: ['::', '0:0:0:0:0:0:0:0', '0.0.0.0', '224.0.0.1', 'not-an-address'],
    public: ['8.8.8.8', '2606:4700:4700::1111', '172.32.0.1', '100.128.0.1', 'fec0::1'],
  };
  for (const [want, list] of Object.entries(same)) for (const ip of list) assert.equal(classify(ip), want, ip);
  for (const host of ['fd00:ec2:0:0:0:0:0:254', '0:0:0:0:0:ffff:a9fe:a9fe']) await assert.rejects(assertReachable(host), /reserved/, 'metadata is never allowed, private hosts or not');
  process.env.UNIT7_BLOCK_PRIVATE_HOSTS = '1';
  try { for (const host of ['::1', '0:0:0:0:0:0:0:1']) await assert.rejects(assertReachable(host), /private network/); }
  finally { delete process.env.UNIT7_BLOCK_PRIVATE_HOSTS; }
});

test('a key can turn itself off, and only a person turns off another', async () => {
  const app = testApp(), http = createHttp(app), a = await testOrg(app, 'Ada'), b = await testOrg(app, 'Bob');
  const signedIn = (o: typeof a) => ({ user: { id: o.userId, email: 'a@example.com', name: 'x' }, org: { id: o.orgId, name: 'x', slug: 'x' }, role: 'owner', via: 'session' }) as never;
  const key = (o: typeof a, role: 'owner' | 'agent' | 'readonly', scope?: string) => createToken(app.db, signedIn(o), 'key', role, undefined, scope);
  const off = async (bearer: string, tokenId: string) => (await http.request(`/api/tokens/${tokenId}`, { method: 'DELETE', headers: { authorization: `Bearer ${bearer}` } })).status;
  const there = (tokenId: string) => !!get(app.db, 'SELECT 1 FROM api_tokens WHERE id = ?', tokenId);
  const owner = key(a, 'owner');
  for (const role of ['readonly', 'agent', 'owner'] as const) assert.equal(await off(key(a, role).token, owner.id), 403, role);
  assert.equal(await off(key(a, 'readonly', 'findings').token, owner.id), 403);
  assert.equal(await off(key(b, 'owner').token, owner.id), 403);
  assert.ok(there(owner.id));
  const mine = key(a, 'readonly');
  assert.equal(await off(mine.token, mine.id), 200, 'its own, yes');
  assert.ok(!there(mine.id));
});

test('a command cancelled while it waits for a channel never starts, and the queue moves on', async () => {
  const app = testApp(), pool = ssh(app) as never as { conns: Map<string, unknown>; exec: (s: unknown, c: string, o?: unknown) => Promise<{ code: number }> }, sent: string[] = [];
  const client = { end() {}, exec(command: string, cb: (e: undefined, s: unknown) => void) {
    sent.push(command);
    const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), end() {}, close() {} });
    cb(undefined, stream); setTimeout(() => stream.emit('close', 0), 5);
  } };
  const conn = { client, ready: Promise.resolve(client), channels: 8, waiters: [] as (() => void)[], lastUsed: Date.now() };
  pool.conns.set('srv', conn);
  const tick = () => new Promise((r) => setTimeout(r, 15)), s = { id: 'srv', name: 'box' }, ac = new AbortController();
  const cancelled = pool.exec(s, 'gave-up', { signal: ac.signal }), next = pool.exec(s, 'still-wanted');
  await tick();
  assert.equal(conn.waiters.length, 2);
  ac.abort(new Error('timed out'));
  await assert.rejects(cancelled, /timed out/);
  assert.equal(conn.waiters.length, 1, 'it left the queue');
  conn.channels--; conn.waiters.shift()!();
  await next;
  assert.deepEqual(sent, ['still-wanted'], 'the free channel went to the one still waiting');
  await assert.rejects(pool.exec(s, 'too-late', { signal: AbortSignal.abort(new Error('already stopped')) }), /already stopped/);
  assert.deepEqual(sent, ['still-wanted']);
  assert.equal(conn.channels, 7, 'and no channel was lost');
  (pool as never as { closeAll: () => void }).closeAll();
});

test('a shutdown lets work finish, stops what won’t, and what a crash cut off gets said', async () => {
  const app = testApp(), o = await testOrg(app), serverId = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready', '{}')`, serverId, o.orgId);
  const answer = { code: 0, stdout: '', stderr: '', truncated: false };
  ssh(app).exec = (async () => { await new Promise((r) => setTimeout(r, 30)); return answer; }) as never;
  const quick = o.h('server.exec', { serverId, command: 'df -h' });
  await drainTools(5000, 10);
  assert.equal((await quick).status, 'ok', 'it finished, and the shutdown waited');
  ssh(app).exec = (() => new Promise(() => undefined)) as never;
  const stuck = o.h('server.exec', { serverId, command: 'df -h' });
  await new Promise((r) => setTimeout(r, 15));
  await drainTools(5, 200);
  const r = await stuck as { status: string; error?: { code: string } };
  assert.equal(r.error?.code, 'shutting_down', 'it was stopped, and said so');
  assert.equal(get<{ result: string }>(app.db, `SELECT result FROM audit WHERE tool = 'server.exec' ORDER BY rowid DESC LIMIT 1`)!.result, 'error', 'in the audit too');

  const old = new Date(Date.now() - 4 * 3600_000).toISOString();
  run(app.db, `INSERT INTO backups (id, org_id, kind, reason, status, created_at) VALUES ('bak_old', ?, 'postgres', 'x', 'running', ?), ('bak_new', ?, 'postgres', 'x', 'running', ?)`, o.orgId, old, o.orgId, new Date().toISOString());
  closeInterrupted(app);
  assert.equal(get<{ status: string }>(app.db, `SELECT status FROM backups WHERE id = 'bak_old'`)!.status, 'failed');
  assert.equal(get<{ status: string }>(app.db, `SELECT status FROM backups WHERE id = 'bak_new'`)!.status, 'running', 'one that could still be going is left alone');
});
