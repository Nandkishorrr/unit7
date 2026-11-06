// Reach: the pass-through to providers' hosted servers, what six more services hold, Stripe webhooks, GitHub Actions and
// secrets, the ask box with nothing to answer it, and a bill that doesn't lose a server. All offline: fake APIs, a fake gh,
// a fake hosted MCP that speaks JSON-RPC, and virtual time for the long call.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account, type Req } from './clouds-fakes.ts';
import { all, get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { HttpMcp } from '../src/connectors/mcp-http.ts';
import { HOSTED_MCP } from '../src/connectors/mcp-oauth.ts';
import { PROFILES } from '../src/ops/index.ts';
import { plainRead } from '../src/policy.ts';
import { perMonth, subCost } from '../src/tools/budget.ts';
import { autopilotView } from '../src/tools/autopilot.ts';
import { costRadar } from '../src/care/radar.ts';
import { githubManifestPage, provider, startConnect } from '../src/connectors/oneclick.ts';
import { blocks, issuesFrom } from '../src/connectors/services.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { targets } from '../src/sentinel/watch.ts';
import { webhookFindings } from '../src/tools/reach.ts';

type Tool = { name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; inputSchema?: object };
// a hosted MCP: JSON-RPC over POST, the tools it was given, each answered by reply()
function fakeMcp(tools: Tool[], reply: (name: string, args: any) => unknown = () => ({ ok: true }), o: { status?: number } = {}) {
  return fakeApi(({ body }: Req) => {
    if (o.status) return [o.status, { error: 'no' }];
    const m = JSON.parse(body || '{}');
    if (m.method === 'initialize') return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } };
    if (m.method === 'tools/list') return { jsonrpc: '2.0', id: m.id, result: { tools } };
    if (m.method === 'tools/call') {
      const out = reply(m.params.name, m.params.arguments);
      return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] } };
    }
    return [202, {}];
  });
}
// an account signed in with one click, on a fake hosted server
function signedIn(app: App, orgId: string, provider: string, mcpUrl: string, name = provider) {
  const acc = id('acc'), slug = acc.slice(4).toLowerCase().replace(/[^a-z0-9]/g, 'x'), ref = `credential://${provider}/${slug}/oauth`;
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta, status) VALUES (?, ?, ?, ?, ?, ?, 'verified')`, acc, orgId, provider, name, slug, JSON.stringify({ ref, auth: 'oauth', mcpUrl }));
  app.vault.put(orgId, ref, JSON.stringify({ access_token: 'signin-token-123456', expires_at: Date.now() + 3600_000, client_id: 'c', token_endpoint: 'http://127.0.0.1:9/', mcp_url: mcpUrl, resource: mcpUrl }), { kind: 'oauth', accountId: acc });
  return acc;
}
const READS = { readOnlyHint: true, destructiveHint: false }, WRITES = { readOnlyHint: false, destructiveHint: false };

test('plainRead: a read verb first, nothing that acts', () => {
  for (const n of ['list_invoices', 'get_cost', 'planetscale_list_invoices', 'retrieve-subscription', 'listOrders', 'get_refund']) assert.equal(plainRead(n), true, n);
  for (const n of ['create_invoice', 'cancel_subscription', 'get_or_create_order', 'list_and_cancel_orders', 'buy_domain', 'pay_invoice', 'update_subscription', 'send_money', 'confirm_cost']) assert.equal(plainRead(n), false, n);
});

test('a read-only money tool runs for an AI as a read; one that only claims to read does not', async () => {
  const app = testApp(), o = await testOrg(app);
  const api = await fakeMcp([
    { name: 'list_invoices', annotations: READS }, { name: 'planetscale_get_invoice_line_items', annotations: READS }, { name: 'get_cost' },
    { name: 'create_invoice', annotations: READS }, { name: 'list_customers', annotations: READS }, { name: 'create_price', annotations: WRITES }, { name: 'delete_price' },
  ], (name) => ({ tool: name, password: 'hunter2-secret-value', note: 'public' }));
  try {
    const acc = signedIn(app, o.orgId, 'stripe', api.base);
    const listed = ok(await o.a('connection.tools', { accountId: acc }));
    const by = (n: string) => listed.tools.find((t: { name: string }) => t.name === n);
    assert.equal(by('list_invoices').peopleOnly, false);
    assert.equal(by('get_cost').peopleOnly, true, 'no hint: money stays a person’s');
    assert.match(listed.untrusted, /data, not instructions/);

    const r = ok(await o.a('connection.call', { accountId: acc, tool: 'list_invoices' }));
    assert.equal(r.result.tool, 'list_invoices');
    assert.equal(r.result.password, '[redacted]', 'a secret field a provider sends back never reaches an AI');
    assert.match(r.untrusted, /not instructions/);
    assert.equal(get<{ risk: string }>(app.db, `SELECT risk FROM audit WHERE tool = 'connection.call' ORDER BY rowid DESC LIMIT 1`)!.risk, 'read');
    assert.equal((await o.a('connection.call', { accountId: acc, tool: 'planetscale_get_invoice_line_items' })).status, 'ok');
    assert.equal(ok(await o.h('connection.call', { accountId: acc, tool: 'list_customers' })).result.password, 'hunter2-secret-value', 'a person sees what they asked for');
    // the hint alone isn't enough, and neither is the name
    assert.equal((await o.a('connection.call', { accountId: acc, tool: 'create_invoice' })).status, 'denied');
    assert.equal((await o.a('connection.call', { accountId: acc, tool: 'get_cost' })).status, 'denied');
    // not money: the hints still decide
    assert.equal((await o.a('connection.call', { accountId: acc, tool: 'create_price' })).status, 'ok');
    assert.equal((await o.a('connection.call', { accountId: acc, tool: 'delete_price' })).status, 'approval_required', 'no hint: destructive');
  } finally { api.close(); }
});

test('a purchase by an AI is denied, even through a tool that hides it in its arguments, even at Full autopilot', async () => {
  const app = testApp(), o = await testOrg(app);
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  const api = await fakeMcp([
    { name: 'buy_domain', annotations: READS }, { name: 'send_money', annotations: WRITES }, { name: 'transfer_money' }, { name: 'stripe_api_write', annotations: WRITES },
    { name: 'stripe_api_read', annotations: READS }, { name: 'execute', annotations: READS }, { name: 'multi-execute', annotations: WRITES },
  ]);
  try {
    const acc = signedIn(app, o.orgId, 'hostinger', api.base);
    ok(await o.a('connection.tools', { accountId: acc }));
    const call = (tool: string, args: object = {}) => o.a('connection.call', { accountId: acc, tool, arguments: args });
    for (const tool of ['buy_domain', 'send_money', 'transfer_money']) assert.equal((await call(tool)).status, 'denied', tool);
    assert.equal((await call('stripe_api_write', { stripe_api_operation_id: 'PostRefunds', parameters: { charge: 'ch_1' } })).status, 'denied');
    assert.equal((await call('execute', { operation: 'billing_orders_create-purchase', params: {} })).status, 'denied', 'a read hint on a wrapper means nothing');
    assert.equal((await call('multi-execute', { steps: [{ operation: 'dns_records_list' }, { operation: 'domains_portfolio_purchase' }] })).status, 'denied');
    assert.equal(api.calls.filter((c) => c.body.includes('tools/call')).length, 0, 'none of them reached the provider');
    // a wrapper with no money in it is still not a read
    const plain = await o.as({ ...o.agent, name: 'x' })('connection.call', { accountId: acc, tool: 'stripe_api_write', arguments: { stripe_api_operation_id: 'PostProducts' } });
    assert.notEqual(plain.status, 'denied');
    assert.equal(get<{ risk: string }>(app.db, `SELECT risk FROM audit WHERE tool = 'connection.call' ORDER BY rowid DESC LIMIT 1`)!.risk, 'destructive');
    // a person's purchase waits for them to confirm
    const mine = await o.h('connection.call', { accountId: acc, tool: 'buy_domain' });
    assert.equal(mine.status, 'approval_required');
    assert.match(get<{ why: string }>(app.db, 'SELECT why FROM approvals WHERE id = ?', (mine as { approvalId: string }).approvalId)!.why, /provider purchase/);
  } finally { api.close(); }
});

test('an unknown tool name is refused, and one Unit7 hasn’t listed counts as destructive', async () => {
  const app = testApp(), o = await testOrg(app);
  const api = await fakeMcp([{ name: 'whoami', annotations: READS }]);
  try {
    const acc = signedIn(app, o.orgId, 'sentry', api.base);
    assert.equal((await o.a('connection.call', { accountId: acc, tool: 'whoami' })).status, 'approval_required', 'cold: not listed yet');
    const r = await o.h('connection.call', { accountId: acc, tool: 'not_a_tool' });
    assert.equal(r.status, 'error');
    assert.equal((r as { error: { code: string } }).error.code, 'unknown_tool');
    assert.equal((await o.a('connection.call', { accountId: acc, tool: 'whoami' })).status, 'ok', 'listed since: a read');
  } finally { api.close(); }
});

test('a pasted key reaches the hosted server, and a refusal there doesn’t mark the account as refused', async () => {
  const app = testApp(), o = await testOrg(app);
  const seen = await fakeMcp([{ name: 'list_products', annotations: READS }]), refuses = await fakeMcp([], undefined, { status: 401 });
  const was = { stripe: HOSTED_MCP.stripe, sentry: HOSTED_MCP.sentry, resend: HOSTED_MCP.resend };
  try {
    HOSTED_MCP.stripe = seen.base; HOSTED_MCP.sentry = seen.base; HOSTED_MCP.resend = refuses.base;
    const stripe = account(app, o.orgId, 'stripe', 'rk_test_pastedkey1234567890');
    assert.equal(ok(await o.a('connection.tools', { accountId: stripe })).tools[0].name, 'list_products');
    assert.equal(seen.calls.at(-1)!.auth, 'Bearer rk_test_pastedkey1234567890');
    // Sentry keeps Bearer for its own sign-in
    const sentry = account(app, o.orgId, 'sentry', 'sntryu_pastedtoken123456');
    ok(await o.a('connection.tools', { accountId: sentry }));
    assert.equal(seen.calls.at(-1)!.headers['sentry-bearer'], 'sntryu_pastedtoken123456');
    assert.equal(seen.calls.at(-1)!.auth, '');

    const resend = account(app, o.orgId, 'resend', 're_pasted_key_1234567890');
    const r = await o.a('connection.tools', { accountId: resend });
    assert.equal(r.status, 'error');
    assert.match((r as { error: { message: string } }).error.message, /don’t take this pasted key. Connect it with one click/);
    assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM accounts WHERE id = ?', resend)!.status, 'verified');

    // fetch throws on a character outside Latin-1: a stray curly quote from a paste says so
    const bad = account(app, o.orgId, 'stripe', 'rk_test_“curly”_key_1234567890', 'Stripe 2');
    const b = await o.h('connection.tools', { accountId: bad });
    assert.equal((b as { error: { code: string } }).error.code, 'bad_key');

    const vercel = account(app, o.orgId, 'vercel', 'vercel-token-123456');
    assert.equal(((await o.h('connection.tools', { accountId: vercel })) as { error: { code: string } }).error.code, 'no_hosted_tools');
    const hostinger = account(app, o.orgId, 'hostinger', 'hostinger-token-123456');
    assert.equal(((await o.h('connection.tools', { accountId: hostinger })) as { error: { code: string } }).error.code, 'use_hostinger_do');
  } finally { Object.assign(HOSTED_MCP, was); seen.close(); refuses.close(); }
});

// virtual time: fetch and AbortSignal.timeout run on the mocked clock, so a 4-minute call takes no time at all
function slowWorld(ms: number) {
  const real = { fetch: globalThis.fetch, timeout: AbortSignal.timeout };
  mock.timers.enable({ apis: ['setTimeout'] });
  AbortSignal.timeout = (t: number) => { const c = new AbortController(); setTimeout(() => c.abort(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), t); return c.signal; };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const m = JSON.parse(String(init.body));
    if (m.method === 'tools/call') await new Promise((done, no) => { setTimeout(done, ms); init.signal!.addEventListener('abort', () => no(init.signal!.reason)); });
    const result = m.method === 'tools/list' ? { tools: [{ name: 'build_everything', annotations: { readOnlyHint: true } }] } : { content: [{ type: 'text', text: '{"done":true}' }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => { globalThis.fetch = real.fetch; AbortSignal.timeout = real.timeout; mock.timers.reset(); };
}
const settle = async () => { for (let n = 0; n < 40; n++) await new Promise((r) => setImmediate(r)); };

test('a 4-minute call finishes: the pass-through waits the 5 minutes it promises, not 120 seconds', async () => {
  const app = testApp(), o = await testOrg(app);
  const acc = signedIn(app, o.orgId, 'supabase', 'http://127.0.0.1:9/mcp');
  const undo = slowWorld(240_000);
  try {
    ok(await o.a('connection.tools', { accountId: acc }));
    const call = o.a('connection.call', { accountId: acc, tool: 'build_everything' });
    await settle();
    mock.timers.tick(121_000); // where it used to stop
    await settle();
    mock.timers.tick(120_000);
    assert.deepEqual(ok(await call).result, { done: true });
  } finally { undo(); }
});

test('a call that outlasts its time says so and warns it may have finished', async () => {
  const undo = slowWorld(600_000);
  try {
    const mcp = new HttpMcp({ url: 'http://127.0.0.1:9/mcp', name: 'Railway', bearer: async () => 't' });
    const call = mcp.callTool('build_everything', {}, 60_000).catch((e: Error) => e);
    await settle();
    mock.timers.tick(61_000);
    const e = await call as Error & { code: string };
    assert.equal(e.code, 'mcp_unreachable');
    assert.match(e.message, /Railway took longer than 60 seconds.*may still have finished/);
  } finally { undo(); }
});

test('the pass-through is in the keys people make, and a read key can’t reach what writes', () => {
  assert.ok(PROFILES.read!.includes('connection.tools'));
  assert.ok(!PROFILES.read!.includes('connection.call'));
  for (const p of ['deploy', 'ops']) for (const t of ['connection.tools', 'connection.call']) assert.ok(PROFILES[p]!.includes(t), `${p}: ${t}`);
});

// --- the bill: a Hostinger plan never drops out without a word ---------------------------------------------------------------
const FUTURE = new Date(Date.now() + 90 * 86400_000).toISOString(), PAST = new Date(Date.now() - 86400_000).toISOString();
const plan = (name: string, o: object) => ({ id: name, name, status: 'active', billing_period: 1, billing_period_unit: 'month', currency_code: 'USD', ...o });

test('subCost: every status and missing field from Hostinger’s docs', () => {
  assert.deepEqual(subCost(plan('kvm', { renewal_price: 2000, total_price: 1000 })), { monthly: 20, currency: 'USD' });
  assert.deepEqual(subCost(plan('kvm', { status: 'not_renewing', renewal_price: 0, total_price: 47976, billing_period: 24, expires_at: FUTURE })), { monthly: 19.99, currency: 'USD' }, 'auto-renew off, paid up front: still a server you pay for');
  assert.deepEqual(subCost(plan('kvm', { status: 'in_trial', total_price: 1200, billing_period: 1, billing_period_unit: 'YEAR' })), { monthly: 1, currency: 'USD' });
  assert.equal(subCost(plan('gone', { status: 'not_renewing', total_price: 900, expires_at: PAST })), undefined);
  for (const status of ['cancelled', 'transferred']) assert.equal(subCost(plan('gone', { status, total_price: 900 })), undefined, status);
  assert.deepEqual(subCost(plan('p', { status: 'paused', total_price: 900 })), { why: 'its status is paused' });
  assert.deepEqual(subCost(plan('f', { status: 'future', total_price: 900 })), { why: 'its status is future' });
  assert.deepEqual(subCost(plan('n', { renewal_price: null, total_price: 0 })), { why: 'Hostinger gave no price' });
  assert.deepEqual(subCost(plan('u', { total_price: 900, billing_period_unit: undefined })), { why: 'Hostinger didn’t say how often it’s billed' });
  assert.deepEqual(subCost(plan('c', { total_price: 900, currency_code: undefined })), { why: 'Hostinger gave no currency' });
});

test('perMonth: a period under a month isn’t rounded up to one', () => {
  assert.equal(Math.round(perMonth(1, 1, 'day') * 10), 304);
  assert.equal(perMonth(120, 1, 'year'), 10);
  assert.equal(perMonth(30, 3, 'Month'), 10);
});

test('the bill keeps a 16 GB VPS with auto-renew off, and marks what it can’t price as unknown', async () => {
  const app = testApp(), o = await testOrg(app);
  account(app, o.orgId, 'hostinger', 'hostinger-token-123456');
  const subs = [
    plan('.com domain', { billing_period_unit: 'year', renewal_price: 1644, total_price: 1644 }),
    plan('KVM 4', { status: 'not_renewing', billing_period: 24, renewal_price: 0, total_price: 47976, expires_at: FUTURE }),
    plan('Business email', { renewal_price: null, total_price: null }),
    plan('Paused box', { status: 'paused', total_price: 999 }),
    plan('Old box', { status: 'cancelled', total_price: 999 }),
    plan('Euro box', { currency_code: 'EUR', total_price: 1000 }),
  ];
  const data = [JSON.stringify(subs), JSON.stringify({ data: subs })];
  app.services.hostinger = { call: async () => data.shift() } as never;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ rates: {} }))) as typeof fetch; // no rate for EUR today
  try {
    for (const round of ['bare list', 'wrapped in data']) {
      const r = ok(await o.h('budget.check'));
      assert.deepEqual(r.costs.map((c: { label: string; amount: number }) => [c.label, c.amount]), [['.com domain', 1.37], ['KVM 4', 19.99]], round);
      assert.deepEqual(r.unknown.map((u: { label: string }) => u.label), ['Business email', 'Paused box', 'Euro box'], round);
      assert.match(r.unknown[2].why, /10\.00 EUR, no exchange rate to USD/);
      assert.ok(r.forecast >= 21.35 && r.forecast < 21.37, `${round}: ${r.forecast}`);
    }
    // the other views show them too, at no amount, and say so
    const view = autopilotView(app.db, o.orgId).budget;
    assert.equal(view.costs.filter((c: { kind: string }) => c.kind === 'unknown').length, 3);
    assert.ok(Math.abs(view.forecast - 21.36) < 0.02);
    const radar = await costRadar({ db: app.db, orgId: o.orgId });
    assert.ok(radar.notes.some((n: string) => /Business email: amount unknown \(Hostinger gave no price\)/.test(n)));
    assert.ok(Math.abs(radar.total - 21.36) < 0.02);
  } finally { globalThis.fetch = real; }
});

// --- GitHub Actions --------------------------------------------------------------------------------------------------------
async function fakeGitHub() {
  const st = { secrets: ['OLD_KEY'], reruns: [] as string[], blobAuth: 'unset' }, calls: Req[] = [];
  let base = '';
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const auth = String(req.headers.authorization ?? ''), p = new URL(req.url!, 'http://x').pathname;
    calls.push({ method: req.method!, path: req.url!, auth, body, headers: req.headers });
    const send = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (p === '/blob/job-71.log') { st.blobAuth = auth; return res.writeHead(200, { 'content-type': 'text/plain' }).end('\x1b[32m2026-11-06T10:00:00.1234567Z Run npm test\x1b[0m\n2026-11-06T10:00:01.1234567Z ##[error]Process completed with exit code 1.\nleaked ghp_abcdefghijklmnopqrstuvwxyz0123456789'); }
    if (auth !== 'Bearer ghp_testtoken1234567890') return send(401, { message: 'Bad credentials' });
    if (p === '/repos/acme/locked/actions/runs') return send(403, { message: 'Resource not accessible by integration' });
    if (p === '/repos/acme/shop') return send(200, { private: true });
    if (p === '/repos/acme/shop/actions/runs') return send(200, { workflow_runs: [{ id: 7, name: 'CI', display_title: 'Fix checkout', status: 'completed', conclusion: 'failure', head_branch: 'main', head_sha: 'abc1234def', event: 'push', html_url: 'https://github.example/run/7', updated_at: '2026-11-06T10:00:00Z' }] });
    if (p === '/repos/acme/shop/actions/runs/7') return send(200, { id: 7, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', head_sha: 'abc1234def', html_url: 'https://github.example/run/7' });
    if (p === '/repos/acme/shop/actions/runs/7/jobs') return send(200, { jobs: [{ id: 70, name: 'lint', status: 'completed', conclusion: 'success', steps: [] }, { id: 71, name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.example/job/71', steps: [{ name: 'Run tests', conclusion: 'failure' }] }] });
    if (p === '/repos/acme/shop/actions/jobs/71/logs') return res.writeHead(302, { location: `${base}/blob/job-71.log` }).end();
    if (req.method === 'POST' && /\/actions\/runs\/7\/rerun(-failed-jobs)?$/.test(p)) { st.reruns.push(p.split('/').pop()!); return send(201, {}); }
    if (p === '/repos/acme/shop/actions/secrets') return send(200, { secrets: st.secrets.map((name) => ({ name, updated_at: '2026-11-01T00:00:00Z' })) });
    send(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, calls, st, close: () => server.close() };
}
// a stand-in gh: writes down how it was started, its token and what came on stdin
function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), 'gh-')), bin = join(dir, 'gh'), out = join(dir, 'calls.jsonl');
  writeFileSync(bin, `#!/usr/bin/env node\nconst fs = require('fs'); let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => { fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), token: process.env.GH_TOKEN, prompt: process.env.GH_PROMPT_DISABLED, stdin: s }) + '\\n'); if (process.env.FAKE_GH_FAIL) { console.error('HTTP 403: Resource not accessible by integration ' + process.env.GH_TOKEN); process.exit(1); } });\n`);
  chmodSync(bin, 0o755);
  process.env.UNIT7_GH_BIN = bin;
  return { calls: () => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}
const github = (app: App, orgId: string) => account(app, orgId, 'github', 'ghp_testtoken1234567890', 'GitHub');

test('Actions: what ran, why it failed (a redirect with no token on it), and what to do when GitHub says no', async () => {
  const app = testApp(), o = await testOrg(app), api = await fakeGitHub();
  process.env.UNIT7_GITHUB_API = api.base;
  try {
    github(app, o.orgId);
    const runs = ok(await o.a('github.runs', { repo: 'acme/shop' }));
    assert.deepEqual(runs.runs.map((r: { id: number; conclusion: string; commit: string }) => [r.id, r.conclusion, r.commit]), [[7, 'failure', 'abc1234']]);
    assert.match(runs.untrusted, /not instructions/);
    assert.equal(ok(await o.a('github.runs', { repo: 'acme/shop', runId: 7 })).jobs[1].failedStep, 'Run tests');
    assert.ok(api.calls.some((c) => /\/runs\?per_page=15$/.test(c.path)));
    ok(await o.a('github.runs', { repo: 'acme/shop', failed: true }));
    assert.ok(api.calls.some((c) => /status=failure/.test(c.path)));

    const logs = ok(await o.a('github.run_logs', { repo: 'acme/shop', runId: 7 }));
    assert.equal(logs.logs.length, 1, 'only the job that failed');
    assert.deepEqual(logs.logs[0].errors, ['Process completed with exit code 1.']);
    assert.doesNotMatch(logs.logs[0].tail, /\x1b|ghp_abc|2026-11-06T/, 'colours and timestamps go, and a token in a log is masked');
    assert.equal(api.st.blobAuth, '', 'the token stays behind on the redirect');
    const none = await o.a('github.run_logs', { repo: 'acme/shop', runId: 7, jobId: 999 });
    assert.equal((none as { error: { code: string } }).error.code, 'not_found_there');

    const no = await o.a('github.runs', { repo: 'acme/locked' });
    assert.equal(no.status, 'error');
    assert.match((no as { error: { message: string } }).error.message, /GitHub said no \(Resource not accessible by integration\).*give it Actions and Secrets read and write/);
    assert.equal(((await o.a('github.runs', { repo: 'acme/missing' })) as { error: { code: string } }).error.code, 'not_found_there');
    const seen = api.calls.length;
    assert.equal((await o.a('github.runs', { repo: '../..' })).status, 'error', 'a path in a repo name goes nowhere');
    assert.equal(api.calls.length, seen);
  } finally { delete process.env.UNIT7_GITHUB_API; api.close(); }
});

test('no GitHub account says what to connect', async () => {
  const app = testApp(), o = await testOrg(app);
  const r = await o.a('github.runs', { repo: 'acme/shop' });
  assert.match((r as { error: { message: string } }).error.message, /Connect one in Connections/);
});

test('several GitHub accounts: the one that can see the repo is used', async () => {
  const app = testApp(), o = await testOrg(app), api = await fakeGitHub();
  process.env.UNIT7_GITHUB_API = api.base;
  try {
    account(app, o.orgId, 'github', 'ghp_someoneelse12345678', 'Other');
    github(app, o.orgId);
    assert.equal(ok(await o.a('github.runs', { repo: 'acme/shop' })).runs.length, 1);
  } finally { delete process.env.UNIT7_GITHUB_API; api.close(); }
});

test('github.workflow_run: an AI asks first, a person runs it, failed jobs unless told otherwise', async () => {
  const app = testApp(), o = await testOrg(app), api = await fakeGitHub();
  process.env.UNIT7_GITHUB_API = api.base;
  try {
    github(app, o.orgId);
    assert.equal((await o.a('github.workflow_run', { repo: 'acme/shop', runId: 7 })).status, 'approval_required');
    assert.deepEqual(api.st.reruns, []);
    ok(await o.h('github.workflow_run', { repo: 'acme/shop', runId: 7 }));
    ok(await o.h('github.workflow_run', { repo: 'acme/shop', runId: 7, failedOnly: false }));
    assert.deepEqual(api.st.reruns, ['rerun-failed-jobs', 'rerun']);
  } finally { delete process.env.UNIT7_GITHUB_API; api.close(); }
});

test('github.secret: sealed by gh with the token in its environment and the value on stdin, and Undo takes a new one back', async () => {
  const app = testApp(), o = await testOrg(app), api = await fakeGitHub(), gh = fakeGh();
  process.env.UNIT7_GITHUB_API = api.base;
  const VALUE = 'sk_live_supersecretvalue1234567890';
  try {
    github(app, o.orgId);
    assert.deepEqual(ok(await o.a('github.secret', { repo: 'acme/shop' })).secrets.map((s: { name: string }) => s.name), ['OLD_KEY']);

    const set = ok(await o.h('github.secret', { repo: 'acme/shop', op: 'set', name: 'STRIPE_KEY', secretValue: VALUE }));
    const c = gh.calls()[0];
    assert.deepEqual(c.args, ['secret', 'set', 'STRIPE_KEY', '--repo', 'acme/shop']);
    assert.equal(c.token, 'ghp_testtoken1234567890');
    assert.equal(c.stdin, VALUE);
    assert.equal(c.prompt, '1');
    assert.ok(!all<{ input: string }>(app.db, `SELECT input FROM audit WHERE tool = 'github.secret'`).some((a) => a.input?.includes('supersecret')), 'never in the audit');

    // a new secret can be taken back; a replaced one can't, and it says so
    ok(await o.h('change.undo', { changeId: set.changeId }));
    assert.deepEqual(gh.calls()[1].args, ['secret', 'delete', 'STRIPE_KEY', '--repo', 'acme/shop']);
    const again = ok(await o.h('github.secret', { repo: 'acme/shop', op: 'set', name: 'old_key', secretValue: VALUE }));
    assert.equal(again.replaced, true);
    assert.match(again.note, /can’t come back/);

    // a reference goes in without an AI ever seeing it
    ok(await o.h('vault.set', { ref: 'credential://app/shop/stripe', value: VALUE }));
    ok(await o.h('github.secret', { repo: 'acme/shop', op: 'set', name: 'FROM_VAULT', secretValue: 'credential://app/shop/stripe' }));
    assert.equal(gh.calls().at(-1).stdin, VALUE);

    // an AI waits for a person, and what it asked for is sealed while it waits
    const ask = await o.a('github.secret', { repo: 'acme/shop', op: 'set', name: 'NEW_KEY', secretValue: VALUE });
    assert.equal(ask.status, 'approval_required');
    assert.doesNotMatch(get<{ input: string }>(app.db, 'SELECT input FROM approvals WHERE id = ?', (ask as { approvalId: string }).approvalId)!.input, /supersecret/);

    // removing needs the name, and an AI's waits too
    assert.equal(((await o.h('github.secret', { repo: 'acme/shop', op: 'remove', name: 'OLD_KEY' })) as { error: { code: string } }).error.code, 'confirm_needed');
    assert.equal((await o.a('github.secret', { repo: 'acme/shop', op: 'remove', name: 'OLD_KEY', confirmName: 'OLD_KEY' })).status, 'approval_required');
    ok(await o.h('github.secret', { repo: 'acme/shop', op: 'remove', name: 'OLD_KEY', confirmName: 'OLD_KEY' }));
    assert.deepEqual(gh.calls().at(-1).args, ['secret', 'delete', 'OLD_KEY', '--repo', 'acme/shop']);

    assert.equal((await o.h('github.secret', { repo: 'acme/shop', op: 'set', name: 'GITHUB_TOKEN', secretValue: 'x' })).status, 'error');

    // gh's own refusal comes through in plain words, with the token masked
    process.env.FAKE_GH_FAIL = '1';
    const no = await o.h('github.secret', { repo: 'acme/shop', op: 'set', name: 'ANOTHER', secretValue: VALUE });
    assert.match((no as { error: { message: string } }).error.message, /GitHub refused that: HTTP 403/);
    assert.doesNotMatch((no as { error: { message: string } }).error.message, /ghp_test/);
  } finally { delete process.env.FAKE_GH_FAIL; delete process.env.UNIT7_GH_BIN; delete process.env.UNIT7_GITHUB_API; api.close(); }
});

test('no gh on this computer: it says so, and how to do it by hand', async () => {
  const app = testApp(), o = await testOrg(app), api = await fakeGitHub();
  process.env.UNIT7_GITHUB_API = api.base; process.env.UNIT7_GH_BIN = join(tmpdir(), 'no-such-gh-here');
  try {
    github(app, o.orgId);
    const r = await o.h('github.secret', { repo: 'acme/shop', op: 'set', name: 'K', secretValue: 'value-123' });
    assert.equal((r as { error: { code: string } }).error.code, 'gh_missing');
    assert.match((r as { error: { message: string } }).error.message, /brew install gh.*Settings → Secrets and variables → Actions/);
  } finally { delete process.env.UNIT7_GH_BIN; delete process.env.UNIT7_GITHUB_API; api.close(); }
});

test('Unit7’s GitHub pages ask for the rights these need', async () => {
  const gh = provider('github')!;
  assert.match(gh.alt!.keyUrl, /scopes=repo,workflow/);
  assert.match(gh.alt!.hint, /Actions logs, re-runs and secrets/);
  const app = testApp(), o = await testOrg(app), origin = 'http://localhost:4800';
  const state = (await startConnect(app, { providerId: 'github', orgId: o.orgId, userId: o.userId, origin })).split('/').pop()!;
  assert.match(githubManifestPage(state, o.userId, origin), /actions&quot;:&quot;write&quot;,&quot;secrets&quot;:&quot;write/);
});

// --- what six more services hold --------------------------------------------------------------------------------------------
const NOW = Math.floor(Date.now() / 1000);
const envs = ['UNIT7_STRIPE_API', 'UNIT7_RESEND_API', 'UNIT7_SENTRY_API', 'UNIT7_TURSO_API', 'UNIT7_UPSTASH_API'];
function fakeServices() {
  const st = { issues: [] as object[], hooks: { sk_live_mapkey123456789012: [{ id: 'we_1', url: 'https://shop.example.com/api/stripe?token=abc', status: 'enabled', enabled_events: ['*'] }] } as Record<string, object[]>, refused: new Set<string>() };
  return fakeApi(({ path, auth }: Req) => {
    const u = new URL(path, 'http://x'), p = u.pathname, token = auth.replace(/^Bearer /, '');
    if (st.refused.has(token)) return [401, { error: { message: 'Invalid API Key provided' } }];
    if (p === '/stripe/account') return { id: 'acct_1', settings: { dashboard: { display_name: 'Shop' } } };
    if (p === '/stripe/webhook_endpoints') return { data: st.hooks[token] ?? [], has_more: false };
    if (p === '/stripe/products') return { data: [{ id: 'prod_1' }, { id: 'prod_2' }], has_more: false };
    if (p === '/stripe/events') return { data: [], has_more: false };
    if (p === '/resend/domains') return { object: 'list', data: [{ id: 'd1', name: 'mail.example.com', status: 'verified', region: 'us-east-1' }] };
    if (p === '/sentry/organizations/') return [{ slug: 'acme', links: { regionUrl: 'https://us.sentry.io' } }];
    if (p === '/sentry/organizations/acme/projects/') return [{ slug: 'shop-web', name: 'Shop web' }];
    if (p === '/sentry/organizations/acme/issues/') return st.issues;
    if (p === '/turso/organizations') return [{ slug: 'acme' }];
    if (p === '/turso/organizations/acme/databases') return { databases: [{ Name: 'orders', DbId: 'db-1', Hostname: 'orders-acme.turso.io' }] };
    if (p === '/upstash/redis/databases') return [{ database_id: 'r1', database_name: 'cache', endpoint: 'calm-fox-1234', state: 'active', password: 'redis-password-do-not-keep', rest_token: 'rest-token-do-not-keep' }];
    return undefined;
  }).then((api) => {
    for (const [e, path] of envs.map((n) => [n, n.replace(/^UNIT7_|_API$/g, '').toLowerCase()] as const)) process.env[e] = `${api.base}/${path}`;
    return Object.assign(api, { st, close: () => { for (const e of envs) delete process.env[e]; api.close(); } });
  });
}
const assetsOf = (app: App) => all<{ provider: string; kind: string; ext_id: string; name: string; url: string | null; meta: string }>(app.db, `SELECT provider, kind, ext_id, name, url, meta FROM assets WHERE provider IN ('stripe', 'resend', 'sentry', 'planetscale', 'turso', 'upstash') ORDER BY provider, name`);

test('a pasted key shows what each account holds, with lines to what uses it, and keeps no password', async () => {
  const app = testApp(), o = await testOrg(app), api = await fakeServices();
  try {
    const stripe = ok(await o.h('account.connect', { provider: 'stripe', token: 'sk_live_mapkey123456789012' }));
    assert.equal(stripe.status, 'verified', 'a pasted Stripe key now does something');
    assert.equal(get<{ name: string }>(app.db, 'SELECT name FROM accounts WHERE id = ?', stripe.accountId)!.name, 'Stripe · live');
    for (const [provider, token] of [['resend', 're_mapkey_123456789012'], ['sentry', 'sntryu_mapkey12345678'], ['turso', 'turso-token-123456'], ['upstash', 'ada@example.com:upstash-key-123']] as const) assert.equal(ok(await o.h('account.connect', { provider, token })).status, 'verified', provider);
    assert.match(api.calls.find((c) => c.path.startsWith('/upstash/'))!.auth, /^Basic /);
    assert.equal(Buffer.from(api.calls.find((c) => c.path.startsWith('/upstash/'))!.auth.slice(6), 'base64').toString(), 'ada@example.com:upstash-key-123');

    // an app the Stripe webhook calls
    const { projectId } = ok(await o.h('project.create', { name: 'Shop' }));
    const env = get<{ id: string }>(app.db, 'SELECT id FROM environments WHERE project_id = ? LIMIT 1', projectId)!.id, svc = id('svc');
    run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind, config) VALUES (?, ?, ?, ?, 'web', 'web', 'app', '{}')`, svc, o.orgId, projectId, env);
    run(app.db, `INSERT INTO domains (id, org_id, service_id, hostname) VALUES (?, ?, ?, 'shop.example.com')`, id('dom'), o.orgId, svc);

    ok(await o.h('sync.run'));
    const found = assetsOf(app);
    assert.deepEqual(found.map((a) => [a.provider, a.kind, a.name]), [['resend', 'service', 'mail.example.com'], ['sentry', 'service', 'Shop web'], ['stripe', 'service', 'Stripe live · Shop'], ['turso', 'database', 'orders'], ['upstash', 'database', 'cache']]);
    assert.equal(JSON.parse(found[2]!.meta).status, '2 products, 1 webhook');
    assert.equal(found.find((a) => a.provider === 'sentry')!.ext_id, 'acme/shop-web');
    assert.deepEqual(JSON.parse(found[4]!.meta).hosts, ['calm-fox-1234.upstash.io'], 'a setting holding that address draws the line');
    assert.deepEqual(JSON.parse(found[3]!.meta).hosts, ['orders-acme.turso.io']);
    assert.doesNotMatch(JSON.stringify(found), /do-not-keep/);
    const edges = all<{ via: string }>(app.db, `SELECT via FROM edges WHERE kind = 'env'`);
    assert.deepEqual(edges.map((e) => e.via), ['live webhook']);
    assert.equal(targets(app, o.orgId).filter((t) => /stripe|sentry|resend/.test(t.host)).length, 0, 'a dashboard is not a site to watch');
  } finally { api.close(); }
});

test('a refused key fails that account’s scan out loud, and keeps its last good look', async () => {
  const app = testApp(), o = await testOrg(app), api = await fakeServices();
  try {
    const acc = account(app, o.orgId, 'stripe', 'sk_live_mapkey123456789012', 'Stripe');
    ok(await o.h('sync.run'));
    assert.equal(assetsOf(app).length, 1);
    api.st.refused.add('sk_live_mapkey123456789012');
    const r = ok(await o.h('sync.run'));
    assert.equal(r.accounts.find((a: { id: string }) => a.id === acc).ok, false);
    assert.match(r.accounts.find((a: { id: string }) => a.id === acc).note, /Stripe refused Unit7/);
    assert.equal(assetsOf(app).length, 1, 'the map doesn’t forget it');
    assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM accounts WHERE id = ?', acc)!.status, 'failing');
  } finally { api.close(); }
});

test('a stray character in a pasted key says so in plain words', async () => {
  const app = testApp(), o = await testOrg(app), api = await fakeServices();
  try {
    const r = ok(await o.h('account.connect', { provider: 'resend', token: 're_“curly”_key_123456' }));
    assert.equal(r.status, 'failing');
    assert.match(r.problem, /stray character/);
  } finally { api.close(); }
});

test('a one-click sign-in reads through the hosted read tools, whatever shape they answer in', async () => {
  const app = testApp(), o = await testOrg(app);
  const api = await fakeMcp([
    { name: 'planetscale_list_organizations', annotations: READS }, { name: 'planetscale_list_databases', annotations: READS, inputSchema: { type: 'object', properties: { organization: { type: 'string' } } } },
    { name: 'list_databases', annotations: READS }, { name: 'redis_database_list_databases', annotations: READS }, { name: 'list-domains', annotations: READS },
    { name: 'find_organizations', annotations: READS }, { name: 'find_projects', annotations: READS }, { name: 'list_available_accounts_or_orgs', annotations: READS }, { name: 'stripe_api_read', annotations: READS },
  ], (name, args) => {
    if (name === 'planetscale_list_organizations') return { data: [{ name: 'acme' }] };
    if (name === 'planetscale_list_databases') { assert.deepEqual(args, { organization: 'acme' }, 'only the arguments it takes'); return { data: [{ name: 'shop', state: 'ready', kind: 'postgresql', html_url: 'https://app.planetscale.com/acme/shop' }] }; }
    if (name === 'list_databases') return { databases: [{ name: 'orders', id: 'db-2', hostname: 'orders.turso.io' }] };
    if (name === 'redis_database_list_databases') return [{ id: 'r2', name: 'cache' }];
    if (name === 'list-domains') return 'Found 2 domains:\n\nName: mail.example.com\nID: d1\nStatus: verified\n\nName: news.example.com\nID: d2\nStatus: failed\n';
    if (name === 'find_organizations') return '# Organizations\n\n## **acme**\n\n**Web URL:** https://acme.sentry.io\n';
    if (name === 'find_projects') return '# Projects in **acme**\n\n- **shop-web**\n- **api**\n';
    if (name === 'list_available_accounts_or_orgs') return { accounts: [{ stripe_context: 'acct_live', livemode: true, display_name: 'Shop' }, { stripe_context: 'acct_sand', livemode: false, display_name: 'Sandbox' }] };
    if (name === 'stripe_api_read') return { data: args.stripe_api_operation_id === 'GetWebhookEndpoints' ? [{ id: `we_${args.stripe_context}`, url: 'https://shop.example.com/hook', status: 'enabled' }] : [] };
    return {};
  });
  try {
    for (const p of ['planetscale', 'turso', 'upstash', 'resend', 'sentry', 'stripe']) signedIn(app, o.orgId, p, api.base, p);
    ok(await o.h('sync.run'));
    const by = (p: string) => assetsOf(app).filter((a) => a.provider === p);
    assert.equal(JSON.parse(by('planetscale')[0]!.meta).engine, 'postgres');
    assert.equal(by('planetscale')[0]!.ext_id, 'acme/shop');
    assert.deepEqual(JSON.parse(by('turso')[0]!.meta).hosts, ['orders.turso.io']);
    assert.equal(by('upstash')[0]!.ext_id, 'r2');
    assert.deepEqual(by('resend').map((a) => [a.name, JSON.parse(a.meta).status]), [['mail.example.com', 'verified'], ['news.example.com', 'failed']]);
    assert.deepEqual(by('sentry').map((a) => a.ext_id).sort(), ['acme/api', 'acme/shop-web']);
    assert.deepEqual(by('stripe').map((a) => a.name), ['Stripe live · Shop', 'Stripe test · Sandbox']);
    assert.equal(JSON.parse(by('stripe')[0]!.meta).status, '0 products, 1 webhook');
  } finally { api.close(); }
});

test('blocks and issuesFrom read the prose hosted servers answer in', () => {
  assert.deepEqual(blocks('- **Name**: a\n- **Status**: ok\n\nName: b'), [{ name: 'a', status: 'ok' }, { name: 'b' }]);
  assert.deepEqual(issuesFrom('# Issues in **acme**\n\n## 1. [SHOP-1](https://acme.sentry.io/issues/1)\n\n**TypeError: boom**\n\n- **Events**: 1,204\n- **Culprit**: `checkout in cart.ts`\n- **Last seen**: 2026-11-06T10:00:00Z\n\n## SHOP-2\n\n**Description**: Other\n**Occurrences**: 3\n'),
    [{ title: 'TypeError: boom', culprit: 'checkout in cart.ts', count: 1204, lastSeen: '2026-11-06T10:00:00Z', url: undefined }, { title: 'Other', culprit: undefined, count: 3, lastSeen: undefined, url: undefined }]);
});

test('a Sentry connection feeds the error view: new issues, not the old ones twice, with what its own count adds', async () => {
  const app = testApp(), o = await testOrg(app), api = await fakeServices();
  const issue = (over: object) => ({ title: 'TypeError: Cannot read id', culprit: 'checkout in cart.ts', count: '40', lastSeen: new Date().toISOString(), permalink: 'https://acme.sentry.io/issues/1', metadata: { type: 'TypeError', value: 'Cannot read id of sk_live_abcdefghijklmnop1234' }, ...over });
  try {
    account(app, o.orgId, 'sentry', 'sntryu_mapkey12345678', 'Sentry');
    ok(await o.h('sync.run'));
    api.st.issues = [issue({})];
    const first = ok(await o.h('errors.scan_hosts'));
    assert.equal(first.apps, 1);
    assert.equal(first.report[0].added, 40);
    const view = async () => ok(await o.h('errors.hosts'));
    const seen = await view();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].provider, 'sentry');
    assert.equal(seen[0].kind, 'TypeError');
    assert.equal(seen[0].frame, 'checkout in cart.ts');
    assert.equal(seen[0].count, 40);
    assert.doesNotMatch(seen[0].message, /sk_live/, 'scrubbed like any log');
    assert.match(api.calls.find((c) => c.path.includes('/issues/'))!.path, /project=shop-web.*sort=date/);

    // 5 more of the same: 5 are added, not 45
    api.st.issues = [issue({ count: '45' })];
    assert.equal(ok(await o.h('errors.scan_hosts')).report[0].added, 5);
    assert.equal((await view())[0].count, 45);
    // seen an hour ago and quiet since: nothing new
    api.st.issues = [issue({ count: '45', lastSeen: new Date(Date.now() - 3600_000).toISOString() })];
    assert.equal(ok(await o.h('errors.scan_hosts')).report.length, 0);
    assert.ok(all(app.db, `SELECT 1 FROM events WHERE type = 'app.errors'`).length >= 1, 'a new error that keeps happening alerts');
  } finally { api.close(); }
});

// --- Stripe webhooks -------------------------------------------------------------------------------------------------------
const hook = (mode: 'test' | 'live', url: string, status = 'enabled') => ({ mode, url, host: new URL(url).hostname, status, events: 1, account: 'Stripe' });
test('webhookFindings: each usual failure, and quiet when it’s right', () => {
  const live = { key: 'STRIPE_SECRET_KEY', target: 'production', value: 'sk_live_a' }, test_ = { key: 'STRIPE_SECRET_KEY', target: 'preview', value: 'sk_test_a' };
  const sign = (target: string, value: string, key = 'STRIPE_WEBHOOK_SECRET') => ({ key, target, value });
  const go = (o: Partial<Parameters<typeof webhookFindings>[0]>) => webhookFindings({ endpoints: [], compared: ['test', 'live'], undelivered: {}, ...o });
  const url = 'https://shop.example.com/hook';
  assert.deepEqual(go({ endpoints: [hook('live', url), hook('test', 'https://test.example.com/hook')], hosts: ['shop.example.com', 'test.example.com'], settings: [live, test_, sign('production', 'whsec_live'), sign('preview', 'whsec_test')] }), []);
  const same = go({ endpoints: [hook('live', url)], hosts: ['shop.example.com'], settings: [live, test_, sign('production', 'whsec_same'), sign('preview', 'whsec_same')] });
  assert.equal(same[0]!.severity, 'critical');
  assert.match(same[0]!.text, /STRIPE_WEBHOOK_SECRET \(production\) and STRIPE_WEBHOOK_SECRET \(preview\) hold the same signing secret/);
  // named settings on one target say their own mode
  assert.match(go({ settings: [{ ...live, target: 'all' }, sign('all', 'whsec_x', 'STRIPE_WEBHOOK_SECRET_TEST'), sign('all', 'whsec_x', 'STRIPE_WEBHOOK_SECRET_LIVE')] })[0]!.text, /same signing secret/);
  assert.match(go({ endpoints: [hook('live', url), hook('test', url)], hosts: ['shop.example.com'], settings: [live, sign('production', 'whsec_one')] })[0]!.text, /gets both test and live events, and this site holds one signing secret/);
  assert.match(go({ endpoints: [hook('test', url)], hosts: ['shop.example.com'], settings: [live, sign('production', 'whsec_one')] })[0]!.text, /runs on a live key, but only a test webhook/);
  assert.deepEqual(go({ endpoints: [hook('test', url)], hosts: ['shop.example.com'], settings: [live, sign('production', 'whsec_one')], compared: ['test'] }), [], 'live wasn’t read: no guess');
  assert.match(go({ settings: [live, { key: 'NEXT_PUBLIC_STRIPE_KEY', target: 'production', value: 'pk_test_x' }] })[0]!.text, /mix a live secret key with a test publishable key/);
  assert.match(go({ endpoints: [hook('live', url)], hosts: ['shop.example.com'], settings: [live] })[0]!.text, /holds no signing secret/);
  assert.match(go({ endpoints: [hook('live', url, 'disabled')] })[0]!.text, /Stripe switched off the live webhook/);
  assert.match(go({ undelivered: { live: 3 } })[0]!.text, /3 live events from the last week didn’t reach a webhook/);
  assert.match(go({ endpoints: [hook('live', url), hook('test', url)], hosts: ['shop.example.com'] })[0]!.text, /couldn’t read this site’s settings/);
});

async function stripeWorld() {
  const st = { hooks: {} as Record<string, object[]>, events: {} as Record<string, object[]> };
  const api = await fakeApi(({ path, auth }: Req) => {
    const u = new URL(path, 'http://x'), p = u.pathname, key = auth.replace(/^Bearer /, '');
    if (p === '/stripe/account') return [403, { error: { message: 'The provided key does not have the required permissions' } }];
    if (p === '/stripe/webhook_endpoints') return { data: st.hooks[key] ?? [], has_more: false };
    if (p === '/stripe/events') return { data: st.events[key] ?? [], has_more: false };
    if (p === '/vercel/v10/projects/prj_shop/env') {
      assert.equal(u.searchParams.get('decrypt'), 'true');
      return { envs: [
        { key: 'STRIPE_SECRET_KEY', value: 'sk_live_sitekey123456789', target: ['production'] }, { key: 'STRIPE_SECRET_KEY', value: 'sk_test_sitekey123456789', target: ['preview', 'development'] },
        { key: 'STRIPE_WEBHOOK_SECRET', value: 'whsec_samesamesamesamesame123456', target: ['production', 'preview'] }, { key: 'DATABASE_URL', value: 'postgres://a:b@db.example.com/x', target: ['production'] },
      ] };
    }
    return undefined;
  });
  process.env.UNIT7_STRIPE_API = `${api.base}/stripe`; process.env.UNIT7_VERCEL_API = `${api.base}/vercel`;
  return Object.assign(api, { st, close: () => { delete process.env.UNIT7_STRIPE_API; delete process.env.UNIT7_VERCEL_API; api.close(); } });
}
const site = (app: App, orgId: string, acc: string) => run(app.db, `INSERT INTO assets (id, org_id, account_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES ('ast_shop', ?, ?, 'vercel', 'app', 'prj_shop', 'shop', 'https://shop.example.com', ?, '2026-11-06')`, orgId, acc, JSON.stringify({ hosts: ['shop.example.com', 'shop.vercel.app'], envKeys: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], end: { kind: 'vercel', accountId: acc, project: 'prj_shop' } }));

test('stripe.webhooks: a site’s test and live endpoints, the same signing secret under both, and never a value', async () => {
  const app = testApp(), o = await testOrg(app), api = await stripeWorld();
  try {
    account(app, o.orgId, 'stripe', 'rk_live_unit7readkey12345', 'Stripe live');
    account(app, o.orgId, 'stripe', 'rk_test_unit7readkey12345', 'Stripe test');
    site(app, o.orgId, account(app, o.orgId, 'vercel', 'vercel-token-123456'));
    api.st.hooks.rk_live_unit7readkey12345 = [{ id: 'we_l', url: 'https://shop.example.com/api/hook?key=abc123', status: 'enabled', enabled_events: ['checkout.session.completed'] }, { id: 'we_o', url: 'https://other.example.com/hook', status: 'enabled' }];
    api.st.hooks.rk_test_unit7readkey12345 = [{ id: 'we_t', url: 'https://shop.example.com/api/hook', status: 'enabled' }];
    api.st.events.rk_live_unit7readkey12345 = [{ id: 'evt_1', created: NOW - 7200, data: { object: { email: 'customer@example.com' } } }, { id: 'evt_2', created: NOW - 60 }, { id: 'evt_3', created: NOW - 30 * 86400 }];

    const r = ok(await o.a('stripe.webhooks', { site: 'shop' }));
    assert.equal(r.site, 'shop');
    assert.deepEqual(r.endpoints.map((e: { mode: string; url: string }) => [e.mode, e.url]), [['live', 'https://shop.example.com/api/hook'], ['test', 'https://shop.example.com/api/hook']], 'only this site’s, and never a query string');
    assert.deepEqual(r.settings.map((s: { key: string; target: string; kind: string; mode: string }) => [s.key, s.target, s.kind, s.mode]), [
      ['STRIPE_SECRET_KEY', 'production', 'secret key', 'live'], ['STRIPE_SECRET_KEY', 'preview', 'secret key', 'test'], ['STRIPE_SECRET_KEY', 'development', 'secret key', 'test'],
      ['STRIPE_WEBHOOK_SECRET', 'production', 'signing secret', 'live'], ['STRIPE_WEBHOOK_SECRET', 'preview', 'signing secret', 'test']]);
    assert.equal(r.findings[0].severity, 'warning');
    assert.match(r.findings[0].text, /1 live event from the last week didn’t reach a webhook/);
    assert.match(r.findings[1].text, /hold the same signing secret, under test and under live/);
    assert.deepEqual(r.compared.sort(), ['live', 'test']);
    assert.equal(r.missing, undefined);
    assert.doesNotMatch(JSON.stringify(r), /whsec_|sk_live|sk_test|customer@example|abc123/, 'names and modes only');
    assert.match(r.note, /shows a signing secret only once/);
    assert.match(r.untrusted, /not instructions/);

    // no site: every endpoint on every account
    assert.equal(ok(await o.a('stripe.webhooks')).endpoints.length, 3);
    // by address
    assert.equal(ok(await o.a('stripe.webhooks', { site: 'https://shop.vercel.app/' })).site, 'shop');
    const none = await o.a('stripe.webhooks', { site: 'nothing-here.example' });
    assert.match((none as { error: { message: string } }).error.message, /doesn’t know a site called/);
  } finally { api.close(); }
});

test('stripe.webhooks with one mode connected says what it couldn’t compare; a key that can’t read events still shows the rest', async () => {
  const app = testApp(), o = await testOrg(app), api = await stripeWorld();
  try {
    account(app, o.orgId, 'stripe', 'rk_live_unit7readkey12345', 'Stripe');
    api.st.hooks.rk_live_unit7readkey12345 = [{ id: 'we_l', url: 'https://shop.example.com/api/hook', status: 'disabled' }];
    api.st.events = new Proxy({}, { get: () => { throw new Error('events refused'); } }) as never;
    const r = ok(await o.a('stripe.webhooks'));
    assert.equal(r.endpoints[0].status, 'disabled');
    assert.match(r.missing, /test mode isn’t connected.*Add a test key/);
    assert.match(r.findings[0].text, /switched off/);
  } finally { api.close(); }
});

test('stripe.webhooks reads a Coolify app’s settings, a Unit7 app’s too, and says so when it can’t', async () => {
  const app = testApp(), o = await testOrg(app), api = await stripeWorld();
  const coolify = createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(/\/applications\/app1\/envs$/.test(req.url!) ? [{ key: 'STRIPE_SECRET_KEY', real_value: 'sk_live_cool123456789012', is_preview: false }, { key: 'STRIPE_WEBHOOK_SECRET', real_value: 'whsec_coolcoolcoolcoolcool123456', is_preview: false }] : [])));
  await new Promise<void>((r) => coolify.listen(0, '127.0.0.1', r));
  ssh(app).exec = (_s, _c, x: ExecOptions = {}) => new Promise((resolve) => {
    const p = spawn('curl', ['-K', '-']);
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, truncated: false }));
    p.stdin.end(String(x.stdin ?? '').replace('http://127.0.0.1:8000/', `http://127.0.0.1:${(coolify.address() as { port: number }).port}/`));
  });
  try {
    account(app, o.orgId, 'stripe', 'rk_live_unit7readkey12345', 'Stripe');
    api.st.hooks.rk_live_unit7readkey12345 = [{ id: 'we_l', url: 'https://shop.example.com/hook', status: 'enabled' }];
    const srv = id('srv');
    run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', '{}')`, srv, o.orgId);
    const acc = account(app, o.orgId, 'coolify', '3|coolifytoken123456', 'Coolify');
    run(app.db, `UPDATE accounts SET meta = json_set(meta, '$.serverId', ?) WHERE id = ?`, srv, acc);
    run(app.db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES ('ast_cool', ?, 'coolify', 'app', ?, 'shop', 'https://shop.example.com', ?, '2026-11-06')`, o.orgId, `${srv}/coolify:app1`, JSON.stringify({ hosts: ['shop.example.com'], owner: 'coolify' }));
    const r = ok(await o.a('stripe.webhooks', { site: 'shop' }));
    assert.deepEqual(r.settings.map((s: { key: string; target: string; mode: string }) => [s.key, s.target, s.mode]), [['STRIPE_SECRET_KEY', 'production', 'live'], ['STRIPE_WEBHOOK_SECRET', 'production', 'live']]);
    assert.deepEqual(r.findings, []);

    // an X-ray part Coolify doesn't run: the endpoints still show, with an open word about the settings
    run(app.db, `UPDATE assets SET provider = 'compose', ext_id = ? WHERE id = 'ast_cool'`, `${srv}/c:shop`);
    const u = ok(await o.a('stripe.webhooks', { site: 'shop' }));
    assert.equal(u.settings, undefined);
    assert.equal(u.endpoints.length, 1);
  } finally { coolify.close(); api.close(); }
});

test('stripe.webhooks through a sign-in reads every place it holds, live and sandbox', async () => {
  const app = testApp(), o = await testOrg(app);
  const api = await fakeMcp([{ name: 'list_available_accounts_or_orgs', annotations: READS }, { name: 'stripe_api_read', annotations: READS }], (name, args) => {
    if (name === 'list_available_accounts_or_orgs') return [{ stripe_context: 'acct_l', livemode: true }, { stripe_context: 'acct_s', livemode: false }];
    if (args.stripe_api_operation_id === 'GetEvents') return { data: [] };
    assert.equal(args.livemode, args.stripe_context === 'acct_l');
    return { data: [{ id: 'we', url: `https://${args.livemode ? 'shop' : 'dev'}.example.com/hook`, status: 'enabled' }] };
  });
  try {
    signedIn(app, o.orgId, 'stripe', api.base, 'Stripe');
    const r = ok(await o.a('stripe.webhooks'));
    assert.deepEqual(r.endpoints.map((e: { mode: string; host: string }) => [e.mode, e.host]), [['live', 'shop.example.com'], ['test', 'dev.example.com']]);
    assert.deepEqual(r.compared.sort(), ['live', 'test']);
  } finally { api.close(); }
});
