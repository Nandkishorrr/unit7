// A domain from idea to live: names and prices from a fake Hostinger, buying (people only, with the domain and price
// typed back, never by an AI), and the launch steps in order, each a gated call, stopping at the first failure.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { testApp, testOrg, ok } from './helpers.ts';
import { hostinger } from '../src/connectors/hostinger.ts';
import { decideApproval, type Ctx, type ToolResult } from '../src/tools/runtime.ts';
import { id, run } from '../src/db.ts';
import { Redactor } from '../src/redact.ts';
import { LAUNCH, launch, splitName, typedCents } from '../src/tools/launch.ts';

process.env.UNIT7_HOSTINGER_CMD = process.execPath;
process.env.UNIT7_HOSTINGER_ARGS = fileURLToPath(new URL('./fake-hostinger-domains.mjs', import.meta.url));
Object.assign(LAUNCH, { pollMs: 5, waitMs: 300 });
const app = testApp();
after(() => hostinger(app).closeAll());

async function withHostinger(name: string, token = 'tok_domains_ok_123456') {
  const o = await testOrg(app, name);
  const acc = ok(await o.h('account.connect', { provider: 'hostinger', name: 'Main', token }));
  const opsRan = async () => (ok(await o.h('hostinger.do', { operation: 'test_ops_list' })).result as { op: string; params: any }[]);
  return { ...o, accountId: acc.accountId as string, opsRan };
}

test('names in, plain domains out', () => {
  assert.deepEqual(splitName('My Shop'), { label: 'myshop' });
  assert.deepEqual(splitName('https://www.MyShop.io/pricing'), { label: 'myshop', tld: 'io' });
  assert.deepEqual(splitName('shop.co.uk'), { label: 'shop', tld: 'co.uk' });
  assert.throws(() => splitName('!!!'), /letters or numbers/);
  assert.equal(typedCents('$11.99'), 1199);
  assert.equal(typedCents('11,99 €'), 1199);
  assert.equal(typedCents('12'), 1200);
  assert.ok(Number.isNaN(typedCents('free')));
});

test('domain ideas: six free names across endings, with prices, from the connected Hostinger', async () => {
  const o = await withHostinger('Sam');
  const ideas = ok(await o.h('domain.ideas', { name: 'My Shop' }));
  assert.deepEqual(ideas.exact, { domain: 'myshop.com', available: false });
  assert.equal(ideas.suggestions.length, 6);
  assert.deepEqual(ideas.suggestions.map((s: any) => s.domain), ['myshop.co', 'myshop.app', 'myshop.dev', 'myshop.net', 'myshop.org', 'myshop.xyz']);
  assert.deepEqual(ideas.suggestions[0].price, { amount: 1199, currency: 'USD', text: '$11.99', renews: '$29.99' });
  assert.ok(ideas.suggestions.every((s: any) => s.available && s.price));
  assert.equal(ideas.canBuy, true);
  // only the answer about the card leaves Unit7, never its details
  assert.doesNotMatch(JSON.stringify(ideas), /4242|Visa/);
  // the ending asked for comes first; Hostinger's own ideas fill in when few are free
  const io = ok(await o.h('domain.ideas', { name: 'myshop.io' }));
  assert.deepEqual(io.exact, { domain: 'myshop.io', available: false });
  // an AI may look (it suggests and prepares)
  assert.equal((await o.a('domain.ideas', { name: 'bakery' })).status, 'ok');
  // no Hostinger connected: it says what to do
  const none = await testOrg(app, 'Nobody');
  const r = await none.h('domain.ideas', { name: 'bakery' });
  assert.equal(r.status === 'error' && r.error.code, 'no_account');
});

test('buying is people only, with the domain and the price typed back', async () => {
  const o = await withHostinger('Lee');
  const bought = async () => (await o.opsRan()).filter((x) => x.op === 'domains_portfolio_purchase');
  // an AI can't buy, even with approval
  const ai = await o.a('domain.buy', { domain: 'myshop.co', confirmName: 'myshop.co', confirmPrice: '11.99' });
  assert.equal(ai.status, 'denied');
  // the person types the domain and the price as shown
  const wrongName = await o.h('domain.buy', { domain: 'myshop.co', confirmName: 'myshop.com', confirmPrice: '11.99' });
  assert.equal(wrongName.status === 'error' && wrongName.error.code, 'confirm_name', 'a wrong name never even waits for an approval');
  const ask = await o.h('domain.buy', { domain: 'myshop.co', confirmName: 'myshop.co', confirmPrice: '11.99' });
  // money is restricted: the person's own buy still waits for an explicit OK on Approvals (owner or admin, typing the domain)
  assert.equal(ask.status, 'approval_required');
  assert.equal((await bought()).length, 0, 'nothing bought yet');
  if (ask.status !== 'approval_required') return;
  await assert.rejects(decideApproval(app, o.orgId, o.human, ask.approvalId, true, 'wrong.co'), /Type the name \(myshop\.co\)/);
  const done = await decideApproval(app, o.orgId, o.human, ask.approvalId, true, 'myshop.co');
  assert.equal(done.status, 'ok', JSON.stringify(done));
  assert.equal((done as any).output.price, '$11.99');
  const p = await bought();
  assert.deepEqual(p.map((x) => x.params), [{ domain: 'myshop.co', item_id: 'hostingercom-domain-co-usd-1y' }]);
});

test('a purchase checks again when it runs: typed name, price, still free, a card on file', async () => {
  // run the tool's checks straight away (a development-only rule set, so no approval in between)
  const o = await withHostinger('Kim');
  run(app.db, `UPDATE orgs SET rules = '{"provider_purchase":"allowed"}' WHERE id = ?`, o.orgId);
  const buy = (input: object) => o.h('domain.buy', input);
  const err = (r: ToolResult) => (r.status === 'error' ? r.error : assert.fail(JSON.stringify(r)));
  assert.equal(err(await buy({ domain: 'myshop.co', confirmName: 'myshop.com', confirmPrice: '11.99' })).code, 'confirm_name');
  const price = err(await buy({ domain: 'myshop.co', confirmName: 'myshop.co', confirmPrice: '9.99' }));
  assert.equal(price.code, 'confirm_price');
  assert.match(price.message, /It costs \$11\.99 now/);
  assert.equal(err(await buy({ domain: 'myshop.com', confirmName: 'myshop.com', confirmPrice: '9.99' })).code, 'taken');
  assert.equal((await o.opsRan()).filter((x) => x.op === 'domains_portfolio_purchase').length, 0);
  // no card on file: it says so and where to buy instead
  const n = await withHostinger('Kim', 'tok_nocard_abcdef');
  run(app.db, `UPDATE orgs SET rules = '{"provider_purchase":"allowed"}' WHERE id = ?`, n.orgId);
  const ideas = ok(await n.h('domain.ideas', { name: 'bakery' }));
  assert.equal(ideas.canBuy, false);
  assert.match(ideas.why, /no card on file/);
  assert.match(ideas.checkout, /^https:\/\/www\.hostinger\.com\//);
  const noCard = err(await n.h('domain.buy', { domain: 'bakery.com', confirmName: 'bakery.com', confirmPrice: '$9.99' }));
  assert.equal(noCard.code, 'no_payment');
  assert.match(noCard.message, /hostinger\.com/);
  assert.equal((await n.opsRan()).filter((x) => x.op === 'domains_portfolio_purchase').length, 0);
});

// --- launch -------------------------------------------------------------------------------------------------------
function ctxFor(o: { orgId: string; human: any }): Ctx {
  return { app, db: app.db, orgId: o.orgId, actor: o.human, env: undefined, projectId: undefined, signal: new AbortController().signal, redactor: new Redactor(), resources: [],
    secret: () => { throw new Error('no secrets here'); }, credentialFor: () => { throw new Error('no credentials here'); }, progress: () => {}, emit: (t, m, e) => app.events.emit(o.orgId, t, m, e) };
}
// stands in for each step's gated tool call; answers what the step needs and writes down the order
function fakeCalls(answers: Partial<Record<string, (input: any, n: number) => ToolResult>> = {}) {
  const calls: { tool: string; input: any }[] = [];
  const okr = (output: unknown): ToolResult => ({ status: 'ok', output, auditId: 'aud_x', durationMs: 1 });
  const base: Record<string, (input: any, n: number) => ToolResult> = {
    'hostinger.do': (_i, n) => okr({ result: [{ domain: 'myshop.co', status: n === 1 ? 'pending_setup' : 'active' }] }),
    'domain.move_dns': () => okr({ next: 'Nameservers switched.' }),
    'domain.point': (i) => okr({ hostname: i.hostname, url: `https://${i.hostname}`, note: 'DNS usually updates within minutes.' }),
    'domain.check': () => okr({ status: 'active', httpsWorking: true, note: 'All good.' }),
    'domain.protect_email': () => okr({ domain: 'myshop.co', dmarc: 'v=DMARC1; p=reject' }),
    'domain.canonical': (i) => okr({ state: 'ok', note: i.prefer === 'www' ? `${i.domain} sends visitors to www.${i.domain}, keeping the page they asked for.` : `www.${i.domain} sends visitors to ${i.domain}, keeping the page they asked for.` }),
  };
  const call = async (tool: string, input: Record<string, unknown>) => { calls.push({ tool, input }); const n = calls.filter((c) => c.tool === tool).length; return (answers[tool] ?? base[tool]!)(input, n); };
  return { calls, call, tools: () => calls.map((c) => c.tool) };
}

test('launch: every step in order, each its own gated call, live as it goes', async () => {
  const o = await withHostinger('Ana');
  const svc = 'svc_aaaaaaaaaaaa';
  run(app.db, `INSERT INTO domains (id, org_id, hostname, status, tls) VALUES (?, ?, 'myshop.co', 'pending', 'issuing')`, id('dom'), o.orgId);
  const seen: string[][] = [];
  const off = app.events.on((e) => { if (e.type === 'domain.launch') seen.push((e.data.steps as { key: string; state: string }[]).map((s) => `${s.key}:${s.state}`)); });
  const f = fakeCalls();
  const r = await launch(ctxFor(o), { domain: 'myshop.co', target: { serviceId: svc }, dns: 'keep' }, f.call);
  off();
  assert.equal(r.live, true);
  assert.equal(r.url, 'https://myshop.co');
  // waited for Hostinger to finish registering it (pending, then active), then each step once
  assert.deepEqual(f.tools(), ['hostinger.do', 'hostinger.do', 'domain.point', 'domain.check', 'domain.protect_email', 'domain.point', 'domain.canonical', 'domain.check']);
  assert.deepEqual(f.calls[2]!.input, { hostname: 'myshop.co', serviceId: svc });
  assert.deepEqual(f.calls[5]!.input, { hostname: 'www.myshop.co', serviceId: svc });
  // www answers, then sends visitors to the bare domain (the main address unless the person picks www)
  assert.deepEqual(f.calls[6]!.input, { domain: 'myshop.co', prefer: 'apex' });
  assert.equal(r.steps[5]!.label, 'www goes to myshop.co');
  assert.match(r.steps[5]!.note!, /www\.myshop\.co sends visitors to myshop\.co/);
  assert.deepEqual(r.steps.map((s) => s.state), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(r.steps[1]!.note, 'Kept at Hostinger.');
  // the window follows along: the first update shows only the first step working
  assert.deepEqual(seen[0], ['ready:running', 'dns:todo', 'point:todo', 'https:todo', 'email:todo', 'www:todo', 'live:todo']);
  assert.ok(seen.length >= 14);

  // moving DNS to Cloudflare is one more gated step, right after the domain is ready
  const cf = fakeCalls();
  await launch(ctxFor(o), { domain: 'myshop.co', target: { serviceId: svc }, dns: 'cloudflare' }, cf.call);
  assert.deepEqual(cf.tools().slice(0, 4), ['hostinger.do', 'hostinger.do', 'domain.move_dns', 'domain.point']);

  // www as the main address: the bare domain sends visitors there
  const w = fakeCalls();
  const wr = await launch(ctxFor(o), { domain: 'myshop.co', target: { serviceId: svc }, dns: 'keep', prefer: 'www' }, w.call);
  assert.deepEqual(w.calls.find((c) => c.tool === 'domain.canonical')!.input, { domain: 'myshop.co', prefer: 'www' });
  assert.equal(wr.steps[5]!.label, 'myshop.co goes to www.myshop.co');
  // a redirect that isn't confirmed yet waits (DNS still spreading), and the launch says so
  const later = fakeCalls({ 'domain.canonical': () => ({ status: 'ok', output: { state: 'waiting', note: 'Set. www.myshop.co will send visitors to myshop.co once its DNS reaches it.' }, auditId: 'a', durationMs: 1 }) });
  const lr = await launch(ctxFor(o), { domain: 'myshop.co', target: { serviceId: svc }, dns: 'keep' }, later.call);
  assert.equal(lr.steps[5]!.state, 'waiting');
  assert.equal(lr.live, true, 'the site itself is live');
});

test('launch stops at the first failure and says what to do; run it again and it picks up', async () => {
  const o = await withHostinger('Bo');
  const target = { serviceId: 'svc_aaaaaaaaaaaa' };
  const f = fakeCalls({ 'domain.point': () => ({ status: 'error', error: { code: 'not_deployed', message: 'Shop isn’t deployed yet. Deploy it first, then point a domain at it.' } }) });
  const r = await launch(ctxFor(o), { domain: 'myshop.co', target, dns: 'keep' }, f.call);
  assert.equal(r.live, false);
  assert.deepEqual(f.tools().slice(-1), ['domain.point'], 'nothing ran after the failure');
  assert.deepEqual(r.steps.map((s) => s.state), ['ok', 'ok', 'failed', 'todo', 'todo', 'todo', 'todo']);
  assert.match(r.next!, /Deploy it first.*picks up where it stopped/);
  // a step that needs a person's OK stops the same way
  const w = fakeCalls({ 'domain.move_dns': () => ({ status: 'approval_required', approvalId: 'apr_x', why: 'needs a person' }) });
  const wr = await launch(ctxFor(o), { domain: 'myshop.co', target, dns: 'cloudflare' }, w.call);
  assert.deepEqual(wr.steps.map((s) => s.state).slice(0, 3), ['ok', 'waiting', 'todo']);
  assert.match(wr.next!, /Approvals/);
  // Hostinger still registering after the wait: it stops and says when to come back
  const slow = fakeCalls({ 'hostinger.do': () => ({ status: 'ok', output: { result: [{ domain: 'myshop.co', status: 'pending_setup' }] }, auditId: 'a', durationMs: 1 }) });
  const sr = await launch(ctxFor(o), { domain: 'myshop.co', target, dns: 'keep' }, slow.call);
  assert.equal(sr.steps[0]!.state, 'waiting');
  assert.match(sr.next!, /still registering/);
});

test('launch works for a domain you already own, and waits where DNS needs you', async () => {
  const o = await testOrg(app, 'Jo'); // no Hostinger here: the domain is registered elsewhere
  run(app.db, `INSERT INTO domains (id, org_id, hostname, status, tls) VALUES (?, ?, 'example.com', 'waiting_dns', 'issuing')`, id('dom'), o.orgId);
  const needs = { dns: 'needs you', addThese: [{ type: 'A', name: '@', value: '203.0.113.9' }], at: 'your DNS provider' };
  const f = fakeCalls({
    'domain.point': (i) => ({ status: 'ok', output: { hostname: i.hostname, ...needs }, auditId: 'a', durationMs: 1 }),
    'domain.check': () => ({ status: 'ok', output: { status: 'waiting_dns', httpsWorking: false, note: 'DNS doesn’t say this yet.' }, auditId: 'a', durationMs: 1 }),
  });
  const r = await launch(ctxFor(o), { domain: 'example.com', target: { vercel: { accountId: 'acc_aaaaaaaaaaaa', project: 'site' } }, dns: 'keep' }, f.call);
  assert.ok(!f.tools().includes('hostinger.do'), 'nothing to wait for at a registrar Unit7 doesn’t have');
  assert.equal(r.steps[0]!.note, 'Registered elsewhere: nothing to wait for.');
  assert.equal(r.steps[1]!.note, 'Kept where it is.');
  assert.equal(r.steps[2]!.state, 'waiting');
  assert.match(r.steps[2]!.note!, /Add A @ → 203\.0\.113\.9 at your DNS provider/);
  assert.equal(r.live, false);
  assert.ok(f.tools().includes('domain.protect_email'), 'what doesn’t depend on DNS still gets done');
  assert.equal(r.steps.at(-1)!.state, 'waiting');
});

test('launch through the gate: an AI prepares it, a person approves; a dry run lists the apps', async () => {
  const o = await testOrg(app, 'Ray');
  const plan = await o.h('domain.launch', { domain: 'example.com' }, { dryRun: true });
  assert.equal(plan.status, 'dry_run');
  assert.deepEqual((plan as any).plan.apps, []);
  assert.equal((plan as any).plan.cloudflare, false);
  const noApp = await o.h('domain.launch', { domain: 'example.com' });
  assert.equal(noApp.status === 'error' && noApp.error.code, 'which_app');
  // a target that isn't this workspace's is refused like any other id
  const foreign = await o.h('domain.launch', { domain: 'example.com', target: { serviceId: 'svc_aaaaaaaaaaaa' } });
  assert.equal(foreign.status === 'error' && foreign.error.code, 'not_found');
  // an AI's launch goes through the same gate as anything else: at “Ask first” a person approves it (each step is gated again when it runs)
  run(app.db, 'UPDATE orgs SET autonomy = 2 WHERE id = ?', o.orgId);
  const vercel = id('acc');
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug) VALUES (?, ?, 'vercel', 'Main', 'main')`, vercel, o.orgId);
  const ai = await o.a('domain.launch', { domain: 'example.com', target: { vercel: { accountId: vercel, project: 'site' } } });
  assert.equal(ai.status, 'approval_required');
});
