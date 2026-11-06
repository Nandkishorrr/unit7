#!/usr/bin/env node
// A tiny MCP stdio server that stands in for @hostinger/mcp in tests. It echoes the token it was
// given (so the test can confirm the vault token reached it) and fakes search/execute/multi-execute.
import { createInterface } from 'node:readline';
const token = process.env.HOSTINGER_API_TOKEN ?? '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock-hostinger', version: '1.0.0' } } });
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search' }, { name: 'execute' }, { name: 'multi-execute' }] } });
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    let text = '';
    // like the real server: JSON with each operation's name and input schema
    if (name === 'search') text = JSON.stringify([
      { operation: 'vps_virtual-machines_list', readOnly: true, inputSchema: { type: 'object', properties: {} } },
      { operation: 'vps_virtual-machines_setup', inputSchema: { type: 'object', properties: { virtualMachineId: { type: 'integer' } } } },
      { operation: 'vps_public-keys_create', inputSchema: { type: 'object', properties: { name: { type: 'string' }, key: { type: 'string' } } } },
      { operation: 'vps_public-keys_attach', inputSchema: { type: 'object', properties: { virtualMachineId: { type: 'integer' }, ids: { type: 'array' } } } },
    ].filter((o) => args.query.split(' ').some((w) => o.operation.includes(w.replace(/s$/, '')))));
    else if (name === 'execute') {
      if (args.operation === 'vps_virtual-machines_list') text = JSON.stringify([{ id: 101, hostname: `srv1-${token.slice(0, 6)}`, state: 'running', ipv4: [{ address: '203.0.113.9' }] }]);
      else if (args.operation === 'vps_public-keys_create') text = JSON.stringify({ id: 55, name: args.params?.name });
      // the test chooses the scenario through the account token (the child doesn't inherit env)
      else if (args.operation === 'vps_virtual-machines_get') text = JSON.stringify({ id: args.params?.virtualMachineId, state: /stopped/.test(token) ? 'stopped' : 'running', firewall_group_id: 367620 });
      else if (args.operation === 'vps_firewall_list') text = JSON.stringify(/fwblock/.test(token)
        ? [{ id: 367620, rules: [{ action: 'accept', protocol: 'TCP', port: '80', source: 'any' }] }]
        : [{ id: 367620, rules: [{ action: 'accept', protocol: 'TCP', port: '22', source: 'any' }] }]);
      else if (['vps_virtual-machines_start','vps_virtual-machines_restart','vps_firewall_create-rule','vps_firewall_sync','vps_public-keys_attach'].includes(args.operation)) text = JSON.stringify({ ok: true, op: args.operation });
      else if (args.operation === 'dns_records_update') text = JSON.stringify({ ok: true, domain: args.params?.domain });
      else text = JSON.stringify({ ok: true, operation: args.operation, params: args.params });
    } else if (name === 'multi-execute') text = JSON.stringify({ ran: (args.operations ?? []).length });
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: false } });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
});
