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
  private header?: string;
  private pasted: boolean;

  // header: where a pasted key goes on a server that keeps Bearer for its own sign-in. pasted: a key a person pasted, not a sign-in
  constructor(o: { url: string; bearer: () => Promise<string>; name: string; header?: string; pasted?: boolean }) {
    this.url = o.url; this.auth = o.bearer; this.name = o.name; this.header = o.header; this.pasted = !!o.pasted;
  }

  // the call may well have finished over there: said so, because a retry could do it twice
  private lost(ms: number) {
    return (e: Error): never => {
      if (e instanceof Unit7Error) throw e;
      throw new Unit7Error('mcp_unreachable', e.name === 'TimeoutError' ? `${this.name} took longer than ${Math.round(ms / 1000)} seconds, so Unit7 stopped waiting. It may still have finished there: look before trying again.` : `Unit7 couldn’t reach ${this.name}. Check the internet connection and try again.`, 502);
    };
  }

  private async post(body: Record<string, unknown>, timeoutMs = 120_000, retried = false): Promise<any> {
    const token = await this.auth();
    if (this.pasted && /[^\x20-\x7e]/.test(token)) throw new Unit7Error('bad_key', `The ${this.name} key has a stray character in it. Paste it again in Connections.`, 400); // fetch throws on one
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        ...(this.header ? { [this.header]: token } : { authorization: `Bearer ${token}` }), 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(this.session && { 'mcp-session-id': this.session }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(this.lost(timeoutMs));
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    // the server forgot our session: open a new one and resend once
    if ((res.status === 404 || res.status === 400) && this.session && !retried && body.method !== 'initialize') {
      this.session = undefined; this.ready = undefined;
      await this.initialize();
      return this.post(body, timeoutMs, true);
    }
    // a key the hosted server won't take can still be fine on the provider's own API, so this never marks the account as refused
    if (this.pasted && (res.status === 401 || res.status === 403)) throw new Unit7Error('mcp_wants_signin', `${this.name}’s hosted tools don’t take this pasted key. Connect it with one click in Connections, or use Unit7’s own tools for it.`, 409);
    if (res.status === 401) throw new Unit7Error('mcp_unauthorized', `${this.name} rejected Unit7's sign-in. Reconnect the account in the Vault.`, 401);
    if (res.status === 202 || body.id === undefined) return undefined;
    const text = await res.text().catch(this.lost(timeoutMs));
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

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<McpTextResult> {
    await this.initialize();
    const r = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } }, timeoutMs);
    return { text: (r?.content ?? []).map((c: { text?: string }) => c.text ?? '').join(''), isError: !!r?.isError, raw: r };
  }

  close() { this.session = undefined; this.ready = undefined; }
}
