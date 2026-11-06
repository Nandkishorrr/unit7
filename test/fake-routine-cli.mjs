#!/usr/bin/env node
// A stand-in for `claude -p` in the routine tests (UNIT7_CLAUDE_BIN points here). It says it's signed in; in a run it
// calls Unit7's MCP endpoint with the token it was handed, tries to save a routine (refused inside a routine), writes
// down what it was asked and what came back, and answers in one line.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let stdin = '';
for await (const c of process.stdin) stdin += c;
const s = JSON.parse(readFileSync(resolve(args[args.indexOf('--mcp-config') + 1]), 'utf8')).mcpServers.unit7;
const call = async (name, a) => JSON.parse((await (await fetch(s.url, { method: 'POST', headers: { ...s.headers, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: a } }) })).json()).result.content[0].text);
const tried = await call('routine_create', { name: 'Sneaky', schedule: 'every hour', ask: 'do it again' });
writeFileSync(process.env.ROUTINE_CLI_RECORD, JSON.stringify({ stdin, tried }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checked staging: all good.' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Checked staging: all good.' });
