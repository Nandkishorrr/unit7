#!/usr/bin/env node
// A stand-in for Hostinger's MCP server in the domain tests: availability, alternatives, the domain price catalog,
// payment methods, purchases and the portfolio, all in memory. The account token picks the scenario ("nocard": no
// card on file). test_ops_list says which operations ran, so a test can prove nothing was bought.
import { createInterface } from 'node:readline';

const token = process.env.HOSTINGER_API_TOKEN ?? '';
const TAKEN = new Set(['myshop.com', 'myshop.io']);
const CATALOG = { com: [999, 1599], io: [3299, 5499], co: [1199, 2999], app: [1299, 1899], dev: [1199, 1699], net: [1299, 1699], org: [899, 1499], xyz: [199, 1499] };
const ops = [];
const owned = new Map(); // domain -> how many times the portfolio was read since it was bought
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

function execute(op, p = {}) {
  ops.push({ op, params: p });
  if (op === 'vps_virtual-machines_list') return [];
  if (op === 'domains_availability_check') return (p.tlds ?? []).map((t) => ({ domain: `${p.domain}.${t}`, is_available: !TAKEN.has(`${p.domain}.${t}`) && !owned.has(`${p.domain}.${t}`), is_alternative: false, restriction: null }));
  if (op === 'domains_availability_suggest-names-from') return [{ domain: `get${p.domain.split('.')[0]}.com` }, { domain: `${p.domain.split('.')[0]}hq.com` }];
  if (op === 'billing_catalog_list') return Object.entries(CATALOG).map(([tld, [first, renew]]) => ({
    id: `hostingercom-domain-${tld}`, name: `.${tld.toUpperCase()} Domain`, category: 'DOMAIN',
    prices: [{ id: `hostingercom-domain-${tld}-usd-1y`, name: `.${tld.toUpperCase()} 1 year`, currency: 'USD', price: renew, first_period_price: first, period: 1, period_unit: 'year' }],
  }));
  if (op === 'billing_payment-methods_list') return /nocard/.test(token) ? [] : [{ id: 7, name: 'Visa', identifier: '**** 4242', is_default: true, is_expired: false, is_suspended: false }];
  if (op === 'domains_portfolio_purchase') { owned.set(p.domain, 0); return { id: 9001, status: 'completed', currency: 'USD' }; }
  if (op === 'domains_portfolio_list') return [...owned].map(([domain, n]) => { owned.set(domain, n + 1); return { id: 1, domain, type: 'domain', status: n < 1 ? 'pending_setup' : 'active' }; });
  if (op === 'test_ops_list') return ops.slice(0, -1);
  return { ok: true, operation: op };
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-hostinger', version: '1.0.0' } } });
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search' }, { name: 'execute' }, { name: 'multi-execute' }] } });
  if (msg.method === 'tools/call') {
    const { name, arguments: a } = msg.params;
    const out = name === 'execute' ? execute(a.operation, a.params) : [];
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false } });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
});
