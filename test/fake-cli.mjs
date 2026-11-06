#!/usr/bin/env node
// A stand-in for `claude -p` and `gemini -p` (tests point UNIT7_CLAUDE_BIN / UNIT7_GEMINI_BIN here). It writes down
// how it was started, calls Unit7's MCP endpoint with the token from its config the way the real CLI would, and
// prints that CLI's stream-json lines. FAKE_CLI_MODE: '' (answers), 'hang' (never ends), 'signed-out', 'ask' (asks the
// person with ui_choose and waits), 'stream' (the reply streams in word by word; FAKE_CLI_TEXT sets it).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLI_MODE ?? '';
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: !process.argv[1].includes('signed-out') && !process.env.FAKE_CLI_SIGNED_OUT })); process.exit(0); }
const gemini = args.includes('--allowed-mcp-server-names');
let stdin = '';
for await (const c of process.stdin) stdin += c;
const file = resolve(gemini ? '.gemini/settings.json' : args[args.indexOf('--mcp-config') + 1]);
const config = JSON.parse(readFileSync(file, 'utf8'));
writeFileSync(process.env.FAKE_CLI_RECORD, JSON.stringify({ args, stdin, file, config, env: Object.keys(process.env), pid: process.pid }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (mode === 'hang') { out({ type: 'system', subtype: 'init' }); setInterval(() => {}, 1000); }
else if (mode === 'ask') {
  const s = config.mcpServers.unit7;
  const rpc = async (method, params) => (await (await fetch(s.url ?? s.httpUrl, { method: 'POST', headers: { ...s.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
  const listed = (await rpc('tools/list', {})).tools.map((t) => t.name).filter((n) => n.startsWith('ui_'));
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Which one?' }, { type: 'tool_use', id: 't1', name: 'mcp__unit7__ui_choose', input: { title: 'Which domain?', source: 'domains' } }] } });
  const answer = (await rpc('tools/call', { name: 'ui_choose', arguments: { title: 'Which domain?', source: 'domains', allowNew: { label: 'Add a new domain' } } })).content[0].text;
  writeFileSync(process.env.FAKE_CLI_RECORD, JSON.stringify({ args, stdin, file, config, env: Object.keys(process.env), pid: process.pid, listed, answer }));
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: answer }] }] } });
  const picked = JSON.parse(answer).output;
  out({ type: 'assistant', message: { content: [{ type: 'text', text: picked.labels ? `Connecting ${picked.labels[0]}.` : 'Okay, not now.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
}
else if (mode === 'stream') {
  const words = process.env.FAKE_CLI_TEXT?.match(/[\s\S]{1,3}/g) ?? 'Your three apps are up and answering quickly.'.split(/(?<= )/); // FAKE_CLI_TEXT: streams in 3-letter bits
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', content: [] } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (const w of words) { out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } } }); await new Promise((r) => setTimeout(r, 30)); }
  out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: words.join('') }] } });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'result', subtype: 'success', is_error: false, result: words.join('') });
}
else if (mode === 'signed-out') { out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }); process.exit(1); }
else {
  const s = config.mcpServers.unit7;
  const r = await fetch(s.url ?? s.httpUrl, { method: 'POST', headers: { ...s.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'graph_get', arguments: {} } }) });
  const result = (await r.json()).result.content[0].text;
  if (gemini) {
    out({ type: 'init', model: 'auto' });
    out({ type: 'message', role: 'assistant', content: 'Checking your ', delta: true });
    out({ type: 'message', role: 'assistant', content: 'servers…', delta: true });
    out({ type: 'tool_use', tool_name: 'mcp_unit7_graph_get', tool_id: 't1', parameters: {} });
    out({ type: 'tool_result', tool_id: 't1', status: 'success', output: result });
    out({ type: 'message', role: 'assistant', content: 'You have no servers yet.', delta: true });
    out({ type: 'result', status: 'success', stats: {} });
  } else {
    out({ type: 'system', subtype: 'init', tools: ['mcp__unit7__graph_get'] });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking your servers…' }, { type: 'tool_use', id: 't1', name: 'mcp__unit7__graph_get', input: {} }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: result }] }] } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'You have no servers yet.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'You have no servers yet.' });
  }
}
