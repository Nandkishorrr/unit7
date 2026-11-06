// A minimal MCP client over stdio. It spawns a server (e.g. the official @hostinger/mcp), does the
// initialize handshake and calls tools. We write ~90 lines instead of pulling in the MCP SDK,
// which peer-depends on a different major than the Agent SDK. Protocol: newline-delimited JSON-RPC
// 2.0 over the child's stdin/stdout (what the MCP stdio transport speaks).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Unit7Error } from '../errors.ts';

export interface McpTextResult { text: string; isError: boolean; raw: unknown }

export interface StdioMcpOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  name?: string;              // for error messages
  readyTimeoutMs?: number;
}

export class StdioMcp {
  private child?: ChildProcessWithoutNullStreams;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private ready?: Promise<void>;
  private stderr = '';
  private opts: StdioMcpOptions;
  private name: string;

  constructor(opts: StdioMcpOptions) {
    this.opts = opts;
    this.name = opts.name ?? opts.command;
  }

  private start() {
    const child = spawn(this.opts.command, this.opts.args ?? [], {
      // a clean env: only PATH plus what the caller passes (so a token is the only secret present)
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...this.opts.env },
      cwd: this.opts.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.onData(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { this.stderr = (this.stderr + d).slice(-4000); });
    child.stdin.on('error', () => undefined); // writing to a child that died is reported by 'exit', not a crash
    // a child that is gone (failed to start, crashed, killed by a signal) fails what waits on it; the next
    // call starts a fresh one. Only for the current child: a replaced one's late exit changes nothing.
    const gone = (e: Error) => { if (this.child !== child) return; this.child = undefined; this.ready = undefined; this.failAll(e); };
    child.on('error', (e) => gone(new Unit7Error('mcp_spawn', `Couldn't start ${this.name}: ${e.message}`, 502)));
    child.on('exit', (code, signal) => gone(new Unit7Error('mcp_exited', `${this.name} exited (${code ?? signal}): ${this.stderr.trim().slice(-500)}`, 502)));
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; } // servers sometimes log plain text to stdout
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Unit7Error('mcp_error', `${this.name}: ${msg.error.message ?? JSON.stringify(msg.error)}`, 502));
        else p.resolve(msg.result);
      }
    }
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private rpc<T = any>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (!this.child) this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Unit7Error('mcp_timeout', `${this.name} did not answer ${method} in time.`, 504)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private notify(method: string, params?: unknown) {
    if (!this.child) this.start();
    this.child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize() {
    this.ready ??= (async () => {
      await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unit7', version: '0.1.0' } }, this.opts.readyTimeoutMs ?? 30_000);
      this.notify('notifications/initialized', {});
    })().catch((e) => { this.close(); throw e; }); // a failed handshake isn't cached: the next call starts over
    return this.ready;
  }

  async listTools(): Promise<{ name: string; description?: string }[]> {
    await this.initialize();
    const r = await this.rpc<{ tools: { name: string; description?: string }[] }>('tools/list', {});
    return r.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<McpTextResult> {
    await this.initialize();
    const r = await this.rpc<{ content?: { type: string; text?: string }[]; isError?: boolean }>('tools/call', { name, arguments: args }, timeoutMs);
    const text = (r.content ?? []).map((c) => c.text ?? '').join('');
    return { text, isError: !!r.isError, raw: r };
  }

  close() {
    this.failAll(new Unit7Error('mcp_closed', `${this.name} was closed.`, 500));
    this.child?.stdin.end();
    this.child?.kill();
    this.child = undefined;
    this.ready = undefined;
  }
}
