// A provider that refuses Unit7's token, or asks it to slow down, must not be asked again and again by
// work nobody is watching: Warden, AI agents and scripts stop; a person can always check once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer as http } from 'node:http';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, run } from '../src/db.ts';
import { Warden } from '../src/sentinel/warden.ts';

// a Vercel API that works, refuses every token, or rate-limits, counting what reaches it
async function fakeVercel() {
  const f = { mode: 'ok' as 'ok' | 'refuse' | 'slow', hits: 0, close: () => {} };
  const server = http((req, res) => {
    f.hits++;
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (f.mode === 'refuse') return send(401, { error: { message: 'The token is not valid', invalidToken: true } });
    if (f.mode === 'slow') return send(429, { error: { message: 'Rate limit exceeded' } });
    const p = new URL(req.url!, 'http://x').pathname;
    if (p === '/v2/user') return send(200, { user: { username: 'ada' } });
    if (p === '/v2/teams') return send(200, { teams: [] });
    if (p === '/v10/projects') return send(200, { projects: [] });
    send(200, { domains: [] });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.UNIT7_VERCEL_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.close = () => { server.close(); delete process.env.UNIT7_VERCEL_API; };
  return f;
}
test('a refused token is tried once by background work, then left alone until a person checks it', async () => {
  const v = await fakeVercel();
  try {
    const app = testApp(); const o = await testOrg(app);
    const acc = ok(await o.h('account.connect', { provider: 'vercel', token: 'vercel-test-token-123' }));
    const status = () => get<{ status: string }>(app.db, 'SELECT status FROM accounts WHERE id = ?', acc.accountId)!.status;
    v.mode = 'refuse'; v.hits = 0;
    for (let i = 0; i < 20; i++) await o.a('sync.run'); // a day of background syncs, compressed
    assert.ok(v.hits <= 2, `asked ${v.hits} times`);
    assert.equal(status(), 'failing');
    const before = v.hits;
    assert.equal(ok(await o.h('account.verify', { accountId: acc.accountId })).status, 'failing', 'a person can always check, once');
    assert.equal(v.hits, before + 1);
    v.mode = 'ok';
    assert.equal(ok(await o.h('account.verify', { accountId: acc.accountId })).status, 'verified');
    const fixed = v.hits;
    await o.a('sync.run');
    assert.ok(v.hits > fixed, 'working again: background work resumes');
  } finally { v.close(); }
});

test('"slow down" pauses background work for that account; people still get through', async () => {
  const v = await fakeVercel();
  try {
    const app = testApp(); const o = await testOrg(app);
    const acc = ok(await o.h('account.connect', { provider: 'vercel', token: 'vercel-test-token-123' }));
    v.mode = 'slow'; v.hits = 0;
    await o.a('sync.run');
    const first = v.hits;
    assert.ok(first >= 1 && first <= 2);
    assert.ok(get<{ pause_until: string | null }>(app.db, 'SELECT pause_until FROM accounts WHERE id = ?', acc.accountId)!.pause_until! > new Date().toISOString());
    for (let i = 0; i < 10; i++) await o.a('sync.run');
    assert.equal(v.hits, first, 'nothing more while paused');
    await o.h('sync.run');
    assert.ok(v.hits > first, 'a person asking goes through');
  } finally { v.close(); }
});

test('a Warden job that fails waits longer each time instead of running on every sweep', async () => {
  const app = testApp(); const o = await testOrg(app);
  const w = new Warden(app) as unknown as { act: (org: string, tool: string, input: unknown, why: string) => Promise<{ status: string }> };
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, port, username, key_ref, status, ssh_block) VALUES (?, ?, 'box', '127.0.0.1', 22, 'root', 'credential://ssh/box/private-key', 'ready', 'key')`, srv, o.orgId);
  const runs = () => get<{ n: number }>(app.db, `SELECT count(*) n FROM audit WHERE org_id = ? AND tool = 'server.inspect'`, o.orgId)!.n;
  for (let i = 0; i < 10; i++) assert.notEqual((await w.act(o.orgId, 'server.inspect', { serverId: srv }, 'test')).status, 'ok');
  assert.equal(runs(), 1, 'once, then it waits');
});
