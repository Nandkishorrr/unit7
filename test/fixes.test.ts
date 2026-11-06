// Fix PRs: merged only once the preview is green; settings default to "open PRs, you merge".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, run } from '../src/db.ts';

test('a fix PR waits for a green preview, then merges, then is forgotten', async () => {
  let status = 'pending';
  const merged: string[] = [];
  const server = createServer((req, res) => {
    const send = (x: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)); };
    if (req.url === '/user') return send({ login: 'ada' });
    if (req.url === '/repos/ada/shop/pulls/7' && req.method === 'GET') return send({ state: merged.length ? 'closed' : 'open', merged: !!merged.length, head: { sha: 'abc123' } });
    if (req.url === '/repos/ada/shop/commits/abc123/status') return send({ state: status });
    if (req.url === '/repos/ada/shop/pulls/7/merge' && req.method === 'PUT') { merged.push('7'); return send({ merged: true }); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.UNIT7_GITHUB_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const app = testApp(); const o = await testOrg(app);
    ok(await o.h('account.connect', { provider: 'github', token: 'ghp_testtokentesttoken0123456789' }));
    const env = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] })).environments[0].id;
    const svc = ok(await o.h('service.create', { environmentId: env, name: 'shop', source: { type: 'git', repo: 'ada/shop' } })).serviceId;
    assert.deepEqual(ok(await o.h('security.fix_settings', { serviceId: svc })), { app: 'shop', openPrs: true, autoMerge: false }, 'open PRs by default; you merge');
    ok(await o.h('security.fix_settings', { serviceId: svc, autoMerge: true }));
    run(app.db, `UPDATE services SET config = json_set(config, '$.fixPr', json('{"number":7,"url":"https://github.com/ada/shop/pull/7","branch":"unit7/fix-vulnerabilities-2026-10-07"}')) WHERE id = ?`, svc);
    assert.deepEqual(ok(await o.a('security.merge_fix', { serviceId: svc })), { waiting: 'checks are pending' });
    assert.equal(merged.length, 0);
    status = 'success';
    assert.equal(ok(await o.a('security.merge_fix', { serviceId: svc })).merged, 'https://github.com/ada/shop/pull/7');
    assert.deepEqual(merged, ['7']);
    assert.equal(JSON.parse(get<{ config: string }>(app.db, 'SELECT config FROM services WHERE id = ?', svc)!.config).fixPr, undefined, 'forgotten once merged');
  } finally { server.close(); delete process.env.UNIT7_GITHUB_API; }
});
