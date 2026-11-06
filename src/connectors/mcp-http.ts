// A minimal MCP client over Streamable HTTP (for hosted MCP servers such as mcp.hostinger.com).
// Same shape as the stdio client: initialize, listTools, callTool. The bearer token comes from a
// callback on every request, so an OAuth token refreshed mid-session is picked up automatically.
import { Unit7Error } from '../errors.ts';
import type { McpTextResult } from './mcp-stdio.ts';

export class HttpMcp {
  private session?: string;
  private ready?: Promise<void>;
  private nextId = 1;
  private url: string;
  private auth: () => Promise<string>;
  private name: string;

  constructor(o: { url: string; bearer: () => Promise<string>; name: string }) {
    this.url = o.url; this.auth = o.bearer; this.name = o.name;
  }

  private async post(body: Record<string, unknown>, retried = false): Promise<any> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.auth()}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(this.session && { 'mcp-session-id': this.session }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    // the server forgot our session: open a new one and resend once
    if ((res.status === 404 || res.status === 400) && this.session && !retried && body.method !== 'initialize') {
      this.session = undefined; this.ready = undefined;
      await this.initialize();
      return this.post(body, true);
    }
    if (res.status === 401) throw new Unit7Error('mcp_unauthorized', `${this.name} rejected Unit7's sign-in. Reconnect the account in the Vault.`, 401);
    if (res.status === 202 || body.id === undefined) return undefined;
    const text = await res.text();
    if (!res.ok) throw new Unit7Error('mcp_http', `${this.name} answered ${res.status}: ${text.slice(0, 200)}`, 502);
    // either one JSON object or an SSE stream of `data:` lines
    const msgs = text.trimStart().startsWith('{') ? [JSON.parse(text)]
      : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return {}; } });
    const msg = msgs.find((m) => m.id === body.id);
    if (!msg) throw new Unit7Error('mcp_http', `${this.name} sent no reply to ${String(body.method)}.`, 502);
    if (msg.error) throw new Unit7Error('mcp_error', `${this.name}: ${msg.error.message}`, 502);
    return msg.result;
  }

  initialize() {
    this.ready ??= (async () => {
      await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unit7', version: '0.1.0' } } });
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    })().catch((e) => { this.ready = undefined; throw e; });
    return this.ready;
  }

  async listTools(): Promise<{ name: string; description?: string }[]> {
    await this.initialize();
    return (await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} }))?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>, _timeoutMs = 120_000): Promise<McpTextResult> {
    await this.initialize();
    const r = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } });
    return { text: (r?.content ?? []).map((c: { text?: string }) => c.text ?? '').join(''), isError: !!r?.isError, raw: r };
  }

  close() { this.session = undefined; this.ready = undefined; }
}
