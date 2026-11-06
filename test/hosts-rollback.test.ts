// Redeploy and roll back apps on Vercel, Netlify and Render (all offline, one fake API): the exact calls per host, the
// last good version before the live one, Vercel's team id on every call, the gate (an AI asks first; important things
// say why), a look at the live address afterwards (verified), and Undo putting back what was live before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account, type Req } from './clouds-fakes.ts';
import { deployTiming, previousGood } from '../src/tools/clouds-deploy.ts';
import { run } from '../src/db.ts';
import type { App } from '../src/app.ts';

deployTiming.pollMs = 1;
const asset = (app: App, orgId: string, id: string, acc: string, provider: string, ext: string, name: string, url: string, meta: object = {}) =>
  run(app.db, `INSERT INTO assets (id, org_id, account_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES (?, ?, ?, ?, 'app', ?, ?, ?, ?, '2026-10-08')`, id, orgId, acc, provider, ext, name, url, JSON.stringify(meta));

test('previousGood: the last good version before the live one, skipping failed ones', () => {
  const v = [{ id: 'd4', good: true }, { id: 'd3', good: true }, { id: 'd2', good: false }, { id: 'd1', good: true }];
  assert.equal(previousGood(v, 'd3'), 'd1');
  assert.equal(previousGood(v, 'd4'), 'd3');
  assert.equal(previousGood(v, 'gone'), 'd4', 'the live one not listed: the newest good one');
  assert.equal(previousGood(v, 'd1'), undefined);
});

test('cloud.redeploy on Vercel, Netlify and Render: exact calls, previous good version, team id, gate, verified, Undo', async () => {
  const st = {
    vercel: 'dpl_3', netlify: 'nd3', render: 'dep-3', renderList: [{ id: 'dep-3', status: 'live' }, { id: 'dep-2', status: 'build_failed' }, { id: 'dep-1', status: 'deactivated' }],
    nlBuilt: false, renderNext: 'build_failed',
  };
  const api = await fakeApi(({ method, path, body }: Req) => {
    const u = new URL(path, 'http://x'), p = u.pathname;
    if (p === '/site/ok') return 'fine';
    if (p === '/site/down') return [503, { error: 'down' }];
    if (p.startsWith('/vercel/')) {
      if (u.searchParams.get('teamId') !== 'team_1') return [403, { error: { message: 'wrong team' } }];
      if (p === '/vercel/v9/projects/prj_1') return { id: 'prj_1', name: 'shop', targets: { production: { id: st.vercel, alias: ['shop.example.com'] } } };
      if (p === '/vercel/v7/deployments' && method === 'GET') return { deployments: [
        { uid: 'dpl_3', readyState: 'READY', isRollbackCandidate: true }, { uid: 'dpl_2', readyState: 'ERROR' },
        { uid: 'dpl_1', readyState: 'READY', isRollbackCandidate: true }, { uid: 'dpl_0', readyState: 'READY', isRollbackCandidate: true }], pagination: {} };
      const rb = /^\/vercel\/v1\/projects\/prj_1\/rollback\/(\w+)$/.exec(p);
      if (rb && method === 'POST') { st.vercel = rb[1]!; return [201, {}]; }
      const pr = /^\/vercel\/v10\/projects\/prj_1\/promote\/(\w+)$/.exec(p);
      if (pr && method === 'POST') { st.vercel = pr[1]!; return [201, {}]; }
      if (p === '/vercel/v13/deployments' && method === 'POST') return { id: 'dpl_4', readyState: 'QUEUED', url: 'shop-4.vercel.app' };
      if (p === '/vercel/v13/deployments/dpl_4') return { id: 'dpl_4', readyState: 'READY' };
    }
    if (p.startsWith('/netlify/')) {
      if (p === '/netlify/sites/site-1') return { id: 'site-1', name: 'blog', account_id: 'a1', published_deploy: { id: st.netlify } };
      if (p === '/netlify/sites/site-1/deploys' && method === 'GET') return [{ id: 'nd3', state: 'ready' }, { id: 'nd2', state: 'ready' }, { id: 'nd1', state: 'ready' }];
      const rs = /^\/netlify\/sites\/site-1\/deploys\/(\w+)\/restore$/.exec(p);
      if (rs && method === 'POST') { st.netlify = rs[1]!; return [201, { id: rs[1] }]; }
      if (p === '/netlify/sites/site-1/builds' && method === 'POST') return { id: 'b1', deploy_id: 'nd4', done: false };
      if (p === '/netlify/sites/site-1/deploys/nd4') { st.netlify = 'nd4'; return { id: 'nd4', state: 'ready' }; }
    }
    if (p.startsWith('/render/')) {
      if (p === '/render/services/srv-1/deploys' && method === 'GET') return st.renderList.map((deploy) => ({ deploy, cursor: 'c' }));
      if (p === '/render/services/srv-1/rollback' && method === 'POST') {
        const back = JSON.parse(body).deployId as string;
        st.renderList = [{ id: `dep-r-${back}`, status: 'live' }, ...st.renderList.map((d) => (d.status === 'live' ? { ...d, status: 'deactivated' } : d))];
        return [201, { id: `dep-r-${back}`, status: 'queued' }];
      }
      const g = /^\/render\/services\/srv-1\/deploys\/([\w-]+)$/.exec(p);
      if (g) return g[1] === 'dep-5' ? { id: 'dep-5', status: st.renderNext } : st.renderList.find((d) => d.id === g[1]) ?? [404, { message: 'no deploy' }];
      if (p === '/render/services/srv-1/deploys' && method === 'POST') return [201, { id: 'dep-5', status: 'build_in_progress' }];
    }
  });
  process.env.UNIT7_VERCEL_API = `${api.base}/vercel`; process.env.UNIT7_NETLIFY_API = `${api.base}/netlify`; process.env.UNIT7_RENDER_API = `${api.base}/render`;
  const calls = (prefix: string) => api.calls.filter((c) => c.path.startsWith(prefix) && c.method !== 'GET').map((c) => `${c.method} ${c.path.split('?')[0]!.slice(prefix.length - 1)}${c.body ? ` ${c.body}` : ''}`);
  try {
    const app = testApp(), o = await testOrg(app);
    const vc = account(app, o.orgId, 'vercel', 'vercel-test-token-123'), nl = account(app, o.orgId, 'netlify', 'nfp_testtoken12345'), rn = account(app, o.orgId, 'render', 'rnd_testtoken123');
    asset(app, o.orgId, 'ast_vercelshop01', vc, 'vercel', 'prj_1', 'shop', `${api.base}/site/ok`, { end: { kind: 'vercel', accountId: vc, project: 'prj_1', team: 'team_1' } });
    asset(app, o.orgId, 'ast_netlifyblog1', nl, 'netlify', 'site-1', 'blog', `${api.base}/site/ok`);
    asset(app, o.orgId, 'ast_renderapi001', rn, 'render', 'srv-1', 'api', `${api.base}/site/down`);

    // the buttons: both, for each host
    for (const id of ['ast_vercelshop01', 'ast_netlifyblog1', 'ast_renderapi001']) assert.deepEqual(ok(await o.h('cloud.app_actions', { asset: id })).modes, ['redeploy', 'rollback']);

    // the gate: an AI asks first (it changes what's live); an important thing says why
    const asked = await o.a('cloud.redeploy', { asset: 'ast_vercelshop01', mode: 'rollback' });
    assert.equal(asked.status, 'approval_required');
    assert.match((asked as any).why, /last good version before the live one/);
    run(app.db, `INSERT INTO kept (org_id, key, name, kind, provider, important) VALUES (?, 'ast_netlifyblog1', 'blog', 'app', 'netlify', 1)`, o.orgId);
    const imp = await o.a('cloud.redeploy', { asset: 'ast_netlifyblog1' });
    assert.equal(imp.status, 'approval_required');
    assert.match((imp as any).why, /marked important/);
    assert.equal(calls('/vercel/').length + calls('/netlify/').length, 0, 'nothing ran');

    // Vercel: roll back to the last good one before the live one (dpl_1: dpl_2 failed), team id on every call
    const vb = ok(await o.h('cloud.redeploy', { asset: 'ast_vercelshop01', mode: 'rollback' }));
    assert.deepEqual(calls('/vercel/'), ['POST /v1/projects/prj_1/rollback/dpl_1']);
    assert.ok(api.calls.filter((c) => c.path.startsWith('/vercel/')).every((c) => c.path.includes('teamId=team_1')), 'the team id on every Vercel call');
    assert.equal(vb.said, 'the previous version is live');
    assert.deepEqual(vb.verified, { fixed: true, checked: [`${api.base}/site/ok`] });
    assert.deepEqual(vb.undo, { tool: 'cloud.redeploy', input: { asset: 'ast_vercelshop01', mode: 'rollback', to: 'dpl_3' } }, 'Undo puts back what was live');
    // Undo: promote (also turns Vercel's auto-assign back on)
    ok(await o.h('cloud.redeploy', vb.undo.input));
    assert.equal(st.vercel, 'dpl_3');
    assert.equal(calls('/vercel/').at(-1), 'POST /v10/projects/prj_1/promote/dpl_3');
    // redeploy: a new build of the live one; ready but not live (auto-assign off) → promoted
    const vr = ok(await o.h('cloud.redeploy', { asset: 'ast_vercelshop01' }));
    const create = api.calls.find((c) => c.method === 'POST' && c.path.startsWith('/vercel/v13/deployments'))!;
    assert.deepEqual(JSON.parse(create.body), { name: 'shop', project: 'prj_1', deploymentId: 'dpl_3', target: 'production' });
    assert.equal(calls('/vercel/').at(-1), 'POST /v10/projects/prj_1/promote/dpl_4');
    assert.equal(vr.said, 'the new build is live');
    assert.equal(vr.undo.input.to, 'dpl_3');

    // Netlify: restore the deploy before the live one; redeploy = a new build, waited for
    const nb = ok(await o.h('cloud.redeploy', { asset: 'ast_netlifyblog1', mode: 'rollback' }));
    assert.deepEqual(calls('/netlify/'), ['POST /sites/site-1/deploys/nd2/restore {}']);
    assert.ok(api.calls.some((c) => c.path === '/netlify/sites/site-1/deploys?production=true&state=ready&per_page=20'));
    assert.equal(nb.verified.fixed, true);
    assert.equal(nb.undo.input.to, 'nd3');
    ok(await o.h('cloud.redeploy', nb.undo.input));
    assert.equal(st.netlify, 'nd3');
    const nr = ok(await o.h('cloud.redeploy', { asset: 'ast_netlifyblog1' }));
    assert.equal(calls('/netlify/').at(-1), 'POST /sites/site-1/builds {}');
    assert.equal(nr.version, 'nd4');

    // Render: rollback with deployId (dep-1: dep-2 never went live); the address is down → verified says so
    const rb = ok(await o.h('cloud.redeploy', { asset: 'ast_renderapi001', mode: 'rollback' }));
    assert.deepEqual(calls('/render/'), ['POST /services/srv-1/rollback {"deployId":"dep-1"}']);
    assert.equal(rb.verified.fixed, false);
    assert.match(rb.verified.still, /error \(HTTP 503\)/);
    assert.match(rb.said, /isn’t answering yet/);
    assert.equal(rb.undo.input.to, 'dep-3');
    // a redeploy whose build fails: an error that says the live site didn't change
    const bad = await o.h('cloud.redeploy', { asset: 'ast_renderapi001' });
    assert.equal(bad.status, 'error');
    assert.match((bad as any).error.message, /failed.*didn’t change/);
    assert.equal(calls('/render/').at(-1), 'POST /services/srv-1/deploys {}');
  } finally {
    api.close(); delete process.env.UNIT7_VERCEL_API; delete process.env.UNIT7_NETLIFY_API; delete process.env.UNIT7_RENDER_API;
  }
});
