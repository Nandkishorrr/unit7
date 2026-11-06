// Providers: the Hostinger MCP client (against a mock server) and the verb→risk gating.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { testApp, testOrg, ok } from './helpers.ts';
import { hostingerRisk, hostinger } from '../src/connectors/hostinger.ts';
import { StdioMcp } from '../src/connectors/mcp-stdio.ts';

const MOCK = fileURLToPath(new URL('./mock-mcp-server.mjs', import.meta.url));
// make the Hostinger pool spawn our mock instead of npx @hostinger/mcp
process.env.UNIT7_HOSTINGER_CMD = process.execPath;
process.env.UNIT7_HOSTINGER_ARGS = MOCK;

const app = testApp();
after(() => hostinger(app).closeAll());

test('hostinger verb → risk mapping', () => {
  assert.equal(hostingerRisk('vps_virtual-machines_list'), 'read');
  assert.equal(hostingerRisk('dns_records_update'), 'destructive'); // domain.point is the checked way
  assert.equal(hostingerRisk('vps_virtual-machines_setup'), 'write');
  assert.equal(hostingerRisk('vps_virtual-machines_recreate'), 'destructive');
  assert.equal(hostingerRisk('billing_orders_create-purchase'), 'destructive');
  assert.equal(hostingerRisk('dns_records_delete'), 'destructive');
  assert.equal(hostingerRisk('vps_virtual-machines_get'), 'read');
  // a read-sounding resource never makes a write a read; domain ownership and unknown verbs need approval
  assert.equal(hostingerRisk('domains_whois_get'), 'read');
  assert.equal(hostingerRisk('domains_whois_change-for'), 'destructive');
  assert.equal(hostingerRisk('domains_whois_delete'), 'destructive');
  assert.equal(hostingerRisk('domains_move_start-outgoing'), 'destructive');
  assert.equal(hostingerRisk('domains_portfolio_update-nameservers'), 'destructive');
  assert.equal(hostingerRisk('domains_forwarding_update'), 'destructive');
  assert.equal(hostingerRisk('vps_virtual-machines_frobnicate'), 'destructive');
  assert.equal(hostingerRisk('vps_metrics_purge'), 'destructive');
});

test('stdio MCP client talks to a server', async () => {
  const m = new StdioMcp({ command: process.execPath, args: [MOCK], env: { HOSTINGER_API_TOKEN: 'tok_secret_123456' }, name: 'mock' });
  const tools = await m.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['execute', 'multi-execute', 'search']);
  const r = await m.callTool('execute', { operation: 'vps_virtual-machines_list', params: {} });
  assert.match(r.text, /srv1/);
  m.close();
});

test('hostinger tools: token comes from the vault, purchase needs approval, reads are free', async () => {
  const o = await testOrg(app);
  // the mock reads the token from env; point the pool at it
  const acc = ok(await o.h('account.connect', { provider: 'hostinger', name: 'Main', token: 'tok_from_vault_abcdef' }));
  assert.equal(acc.status, 'verified'); // verifier ran vps list through the mock
  assert.equal(acc.facts.vps, 1);

  // a read runs freely and the mock confirms it saw our vault token (first 6 chars)
  const list = ok(await o.h('hostinger.vps_list', {}));
  assert.match(JSON.stringify(list.vps), /tok_fr/);
  assert.equal(list.vps[0].ip, '203.0.113.9');

  // a destructive op (recreate) is gated even at high autonomy
  const recreate = await o.a('hostinger.do', { operation: 'vps_virtual-machines_recreate', params: { id: 101 } });
  assert.equal(recreate.status, 'approval_required');

  // a plain write op runs
  const dns = ok(await o.h('hostinger.do', { operation: 'dns_records_update', params: { domain: 'example.com' } }));
  assert.match(JSON.stringify(dns.result), /example\.com/);

  // search works
  const found = ok(await o.h('hostinger.search', { query: 'create vps' }));
  assert.match(found.result, /vps_virtual-machines/);
});

test('secrets never leak through hostinger output', async () => {
  const o = await testOrg(app, 'Bob');
  ok(await o.h('account.connect', { provider: 'hostinger', name: 'B', token: 'tok_bob_SECRETVALUE_99' }));
  const list = ok(await o.h('hostinger.vps_list', {}));
  // the mock only echoes the first 6 chars of the token; the full secret must never appear
  assert.ok(!JSON.stringify(list.vps).includes('tok_bob_SECRETVALUE_99'));
});
