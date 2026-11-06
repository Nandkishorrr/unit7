// `unit7 mcp`: a stdio MCP server that forwards each JSON-RPC message to the Unit7 server's /mcp
// HTTP endpoint with the saved token. The AI agent (Claude Code, Cursor) speaks stdio to this proxy.
import { createInterface } from 'node:readline';
import type { CliConfig } from './client.ts';

export async function proxyStdioMcp(c: CliConfig) {
  const rl = createInterface({ input: process.stdin });
  const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    try {
      const res = await fetch(`${c.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: JSON.stringify(msg) });
      if (res.status === 202) continue; // notification, no reply
      send(await res.json());
    } catch (e) {
      if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Unit7 unreachable: ${(e as Error).message}` } });
    }
  }
}
