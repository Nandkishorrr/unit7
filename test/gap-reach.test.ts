// Reach: the pass-through to providers' hosted servers, what six more services hold, Stripe webhooks, GitHub Actions and
// secrets, the ask box with nothing to answer it, and a bill that doesn't lose a server. All offline: fake APIs, a fake gh,
// a fake hosted MCP that speaks JSON-RPC, and virtual time for the long call.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account, type Req } from './clouds-fakes.ts';
import { get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { HttpMcp } from '../src/connectors/mcp-http.ts';
import { HOSTED_MCP } from '../src/connectors/mcp-oauth.ts';
import { PROFILES } from '../src/ops/index.ts';
import { plainRead } from '../src/policy.ts';

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
