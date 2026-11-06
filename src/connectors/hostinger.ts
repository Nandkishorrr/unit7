// Hostinger, a key integration: Unit7 drives Hostinger through its OWN official MCP
// server (@hostinger/mcp), one process per connected account, with that account's API token
// injected from the vault. The AI never sees the token. All ~407 Hostinger operations are reachable
// through `search` / `execute` / `multi-execute`; Unit7 gates each by verb so money-spending and
// destructive calls route through the policy gate.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { App } from '../app.ts';
import type { Ctx } from '../tools/runtime.ts';
import { StdioMcp } from './mcp-stdio.ts';
import type { HttpMcp } from './mcp-http.ts';
import { isOAuthAccount, oauthMcp } from './mcp-oauth.ts';
import { get } from '../db.ts';
import { Unit7Error } from '../errors.ts';

// Pin the version: never run @latest against someone's live account.
export const HOSTINGER_MCP_VERSION = '2.7.3'; // pinned in package.json too, with its lockfile hash

// Hostinger's own MCP server, installed with Unit7 (exact version, every dependency locked by hash in
// package-lock.json) and run by this Node: nothing is fetched at run time, so a package published later
// can't slip in between Unit7 and the token it is handed.
const require = createRequire(import.meta.url);
const hostingerEntry = () => { const pkg = require.resolve('@hostinger/mcp/package.json'); return join(dirname(pkg), (require(pkg) as { bin: { mcp: string } }).bin.mcp); };

// Verb → risk. Hostinger operation ids are `area_resource_verb`: `vps_virtual-machines_list`,
// `dns_records_update`, `billing_orders_create-purchase`, `domains_whois_change-for`. Only the verb (the
// last part) can make an operation a read, so a resource named like a read (`whois`, `metrics`) never does.
// Anything that can lose data, money or a domain is destructive (a DNS change can send a live site elsewhere:
// domain.point is the checked way to do it), and so is any verb Unit7 doesn't know.
export function hostingerRisk(operation: string): 'read' | 'write' | 'destructive' {
  const op = operation.toLowerCase();
  const verb = op.slice(op.lastIndexOf('_') + 1);
  if (/^(list|get|check|search|status|show|view)(-|$)/.test(verb)) return 'read';
  if (/(purchase|recreate|snapshots_create|delete|reset|destroy|cancel|remove|restore|password|payment|disable|wipe|replace|whois|move|transfer|nameserver|forwarding|lock|privacy|contact|owner|stop|dns|public-key|ssh-key|firewall|remote-connection|ftp|user|token|api-key|member|access)/.test(op)) return 'destructive';
  if (/^(create|update|setup|set|add|attach|enable|start|restart|reboot|install|activate|upload|deploy|import|sync|generate|verify|validate|run|build|clear|flush|refresh|change)(-|$)/.test(verb)) return 'write';
  return 'destructive';
}

interface Pooled { client: StdioMcp; lastUsed: number; token: string }

export class HostingerPool {
  private clients = new Map<string, Pooled>(); // keyed by account id
  private app: App;
  private reaper: NodeJS.Timeout;
  constructor(app: App) {
    this.app = app;
    this.reaper = setInterval(() => { for (const [id, p] of this.clients) if (Date.now() - p.lastUsed > 5 * 60_000) { p.client.close(); this.clients.delete(id); } }, 60_000);
    this.reaper.unref();
  }

  // A client bound to one account, token injected from the vault for this call.
  private client(accountId: string, token: string): StdioMcp {
    let p = this.clients.get(accountId);
    // a rotated or replaced token takes effect at once: the old process (holding the old one) is stopped
    if (p && p.token !== token) { p.client.close(); this.clients.delete(accountId); p = undefined; }
    if (!p) {
      const client = new StdioMcp({
        command: process.env.UNIT7_HOSTINGER_CMD ?? process.execPath,
        args: process.env.UNIT7_HOSTINGER_CMD ? (process.env.UNIT7_HOSTINGER_ARGS?.split('\n').filter(Boolean) ?? []) : [hostingerEntry()],
        env: { HOSTINGER_API_TOKEN: token, DEBUG: '' },
        name: 'the Hostinger MCP server', readyTimeoutMs: 60_000,
      });
      this.clients.set(accountId, (p = { client, lastUsed: Date.now(), token }));
    }
    p.lastUsed = Date.now();
    return p.client;
  }

  async call(ctx: Ctx, accountId: string, tool: 'search' | 'execute' | 'multi-execute', args: Record<string, unknown>, timeoutMs = 120_000) {
    const acc = get<{ meta: string; provider: string }>(ctx.db, 'SELECT meta, provider FROM accounts WHERE id = ? AND org_id = ?', accountId, ctx.orgId);
    if (!acc || acc.provider !== 'hostinger') throw new Unit7Error('no_account', 'That Hostinger account was not found.', 404);
    let client: StdioMcp | HttpMcp;
    let name: string = tool;
    if (isOAuthAccount(acc.meta)) {
      // signed in with one click: Hostinger's hosted MCP over HTTP. It may prefix tool names; match by suffix.
      const m = oauthMcp(ctx, accountId);
      const names = (await m.tools()).map((t: { name: string }) => t.name);
      name = names.find((t: string) => t === tool) ?? names.find((t: string) => t.endsWith(tool)) ?? tool;
      client = m.client;
    } else {
      const { value } = ctx.credentialFor('hostinger', accountId);
      client = this.client(accountId, value);
    }
    const r = await client.callTool(name, args, timeoutMs);
    const text = ctx.redactor.redact(r.text);
    if (r.isError) throw new Unit7Error('hostinger_error', `Hostinger said: ${text.slice(0, 600)}`, 502);
    return text;
  }

  closeAccount(accountId: string) { this.clients.get(accountId)?.client.close(); this.clients.delete(accountId); }
  closeAll() { clearInterval(this.reaper); for (const p of this.clients.values()) p.client.close(); this.clients.clear(); }
}

export function hostinger(app: App): HostingerPool {
  return ((app.services.hostinger as HostingerPool | undefined) ??= new HostingerPool(app));
}
