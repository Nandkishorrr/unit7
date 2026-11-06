// Unit7 must never get someone's address banned: a server that refuses its key, or doesn't answer,
// sees one or two sign-in attempts however long its page stays open, not one every few seconds.
// Runs against small SSH and TCP servers in this process, so it needs no Docker.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, run } from '../src/db.ts';
import { ssh } from '../src/connectors/ssh.ts';

process.env.UNIT7_SKIP_NET_PROBE = '1';
const app = testApp();
after(() => ssh(app).closeAll());

// an SSH server that refuses every key, counting connections that tried to sign in
async function refusingServer() {
  const seen = new Set<object>();
  const srv = new ssh2.Server({ hostKeys: [ssh2.utils.generateKeyPairSync('ed25519').private] }, (client) => {
    client.on('authentication', (a) => { seen.add(client); a.reject(['publickey']); }).on('error', () => undefined);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { port: (srv.address() as AddressInfo).port, signIns: () => seen.size, close: () => srv.close() };
}
const status = (srv: string) => get<{ status: string; ssh_block: string | null }>(app.db, 'SELECT status, ssh_block FROM servers WHERE id = ?', srv)!;

test('a server that refuses Unit7’s key sees at most one sign-in, however long its page is open', { timeout: 60_000 }, async () => {
  const fake = await refusingServer();
  const o = await testOrg(app);
  try {
    // Unit7 makes a key: it can't be on the server yet, so nothing tries it
    const c = ok(await o.h('server.connect', { name: 'NoKey', host: '127.0.0.1', port: fake.port }));
    assert.equal(status(c.serverId).ssh_block, 'key');
    assert.ok(c.command.includes(c.publicKey.split(' ')[1]), 'the one-line command carries the exact key');

    // the server's page, open for 10 minutes: status, metrics, logs and containers every 15 seconds
    const page = () => Promise.all([
      o.h('server.inspect', { serverId: c.serverId }), o.h('server.metrics', { serverId: c.serverId }),
      o.h('server.logs', { serverId: c.serverId, source: 'journal', lines: 50 }), o.h('docker.list', { serverId: c.serverId }),
    ]);
    for (let i = 0; i < 40; i++) for (const r of await page()) assert.equal((r as any).error?.code, 'key_refused');
    const d = ok(await o.h('server.diagnose', { serverId: c.serverId }));
    assert.equal(d.cause, 'key');
    assert.deepEqual(d.fixes.map((f: any) => f.id), ['install-key', 'check-key']);
    assert.equal(fake.signIns(), 0, 'not a single sign-in with a key the server hasn’t got');

    // "I've added it — check again": exactly one sign-in, reported honestly, with the command again
    const again = await o.h('server.repair', { serverId: c.serverId, fix: 'check-key' });
    assert.equal((again as any).error.code, 'still_refused');
    assert.match((again as any).error.message, /authorized_keys/);
    assert.equal(fake.signIns(), 1);
    for (let i = 0; i < 40; i++) await page();
    assert.equal(fake.signIns(), 1, 'refused once: no more attempts until someone changes something');

    // a restart doesn't forget it
    ssh(app).closeAll(); delete (app.services as Record<string, unknown>).ssh;
    assert.equal(((await o.h('server.inspect', { serverId: c.serverId })) as any).error.code, 'key_refused');
    assert.equal(fake.signIns(), 1);

    // everything asked at the same moment shares one attempt
    run(app.db, 'UPDATE servers SET ssh_block = NULL WHERE id = ?', c.serverId);
    await page();
    assert.equal(fake.signIns(), 2, 'four requests, one sign-in');
    assert.equal(status(c.serverId).ssh_block, 'key');
    assert.notEqual((await o.a('server.repair', { serverId: c.serverId, fix: 'install-key' })).status, 'ok', 'only a person adds a key with this Mac’s access');
  } finally { fake.close(); }
});

test('a server that doesn’t answer is tried after 20 seconds, then 1, 5 and 15 minutes', { timeout: 60_000 }, async () => {
  // answers the TCP connection, then drops it: like a server whose firewall cuts this computer off
  let attempts = 0;
  const tcp = createServer((s) => { attempts++; s.destroy(); });
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
  const port = (tcp.address() as AddressInfo).port;
  const realNow = Date.now; let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const o = await testOrg(app);
    const key = ssh2.utils.generateKeyPairSync('ed25519').private;
    const c = await o.h('server.connect', { name: 'Gone', host: '127.0.0.1', port, privateKey: key });
    assert.equal((c as any).error.code, 'unreachable');
    const srv = get<{ id: string }>(app.db, `SELECT id FROM servers WHERE org_id = ? AND name = 'gone'`, o.orgId)!.id;
    let last: any;
    for (let t = 15; t <= 600; t += 15) { // the page asking every 15 seconds for 10 minutes
      offset = t * 1000;
      last = await o.h('server.metrics', { serverId: srv });
    }
    assert.equal(attempts, 4, 'at 0s, 30s, 1m30s and 6m30s; the next one waits 15 minutes');
    assert.match(last.error.message, /tries again in \d+ minutes/);
  } finally { Date.now = realNow; tcp.close(); }
});
