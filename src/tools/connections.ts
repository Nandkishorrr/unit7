// Any provider connected with one click (Supabase, Stripe, Sentry, Neon…) through its own hosted MCP.
// Unit7 holds the sign-in; the AI only names the account and the provider's tool. Risk follows the
// provider's own hints: read-only tools run freely, destructive ones go through approval, the rest
// are treated as writes.
import { z } from 'zod';
import { defineTool } from './runtime.ts';
import { get } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { bearerFor, oauthMcp, toolHint } from '../connectors/mcp-oauth.ts';
import { fid } from './helpers.ts';
import { MONEY_OP } from '../policy.ts';

const account = () => z.object({ accountId: fid('acc').describe('From account.list: an account connected with one click') });

defineTool({
  name: 'connection.tools', title: 'List what a connected service can do', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'List the tools of a provider connected with one click (Supabase, Stripe, Sentry, Neon, Resend…), with whether each only reads. Use before connection.call.',
  input: account(),
  async run(ctx, i) {
    const tools = await oauthMcp(ctx, i.accountId).tools();
    return tools.map((t) => ({ name: t.name, description: t.description?.slice(0, 300), readOnly: t.annotations?.readOnlyHint === true, destructive: t.annotations?.destructiveHint === true }));
  },
});

defineTool({
  name: 'connection.call', title: 'Use a connected service',
  risk: (i) => toolHint(i.accountId, i.tool), timeoutMs: 5 * 60_000,
  // a tool that buys, pays, refunds or changes a plan: people-only for an AI, a provider_purchase for a person
  action: (i) => (MONEY_OP.test(i.tool) && toolHint(i.accountId, i.tool) !== 'read' ? 'provider_purchase' : `connection_${toolHint(i.accountId, i.tool)}`),
  peopleOnly: (i) => MONEY_OP.test(i.tool),
  description: 'Call one tool of a provider connected with one click, e.g. list Supabase projects, read Sentry issues, create a Stripe price. Unit7 signs the call; you never see a token.',
  input: z.object({ accountId: fid('acc'), tool: z.string().min(1).max(120), arguments: z.record(z.string(), z.unknown()).default({}) }),
  async run(ctx, i) {
    const m = oauthMcp(ctx, i.accountId);
    await bearerFor(ctx, get<{ provider: string }>(ctx.db, 'SELECT provider FROM accounts WHERE id = ?', i.accountId)!.provider, i.accountId); // teaches this run's redactor the bearer
    if (!(await m.tools()).some((t) => t.name === i.tool)) throw new Unit7Error('unknown_tool', `${i.tool} isn't one of this service's tools. Call connection.tools first.`, 400);
    const r = await m.client.callTool(i.tool, i.arguments, 5 * 60_000);
    const text = ctx.redactor.redact(r.text);
    const name = get<{ name: string }>(ctx.db, 'SELECT name FROM accounts WHERE id = ?', i.accountId)?.name ?? 'The service';
    if (r.isError) throw new Unit7Error('service_error', `${name} said: ${text.slice(0, 600)}`, 502);
    ctx.emit('connection.call', `${name}: ${i.tool}`, { data: { tool: i.tool } });
    try { return JSON.parse(text); } catch { return { result: text }; }
  },
});

// --- what to connect next: what the map saw that one more connection would unlock (Connections → "Found for you") ---
// Domains whose DNS no connected account serves (public DNS names the host, one lookup per root domain) and Coolify
// found inside a server by its X-ray. Only providers Unit7 can actually connect are suggested.
import { all, json } from '../db.ts';
import { pool } from '../discovery/scanners.ts';
import { dnsHost } from '../connectors/dnsinfo.ts';
import { provider as catalogProvider } from '../connectors/oneclick.ts';
import type { Found } from '../discovery/model.ts';

const DNS_TILE: Record<string, string> = { google: 'gcp', route53: 'aws' }; // nameserver families → the tile that edits them
defineTool({
  name: 'connection.suggestions', title: 'What to connect next', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'What the map saw that a connection would unlock: domains whose DNS sits at a provider that is not connected yet (connect it and Unit7 can edit their records), and Coolify found on a server. From the last sync.',
  input: z.object({}),
  async run(ctx) {
    const have = new Set(all<{ provider: string; meta: string }>(ctx.db, 'SELECT provider, meta FROM accounts WHERE org_id = ?', ctx.orgId).flatMap((a) => [a.provider, ...(a.provider === 'coolify' ? [`coolify:${json<{ serverId?: string }>(a.meta, {}).serverId}`] : [])]));
    const assets = all<{ kind: string; name: string; meta: string }>(ctx.db, 'SELECT kind, name, meta FROM assets WHERE org_id = ?', ctx.orgId).map((a) => ({ kind: a.kind, name: a.name, m: json<Found>(a.meta, {} as Found) }));
    // ponytail: the last two labels stand in for the root when no scan said its zone (example.co.uk asks co.uk, finds nothing)
    const roots = [...new Set(assets.filter((a) => a.kind === 'domain' && !a.m.dns).map((a) => a.m.zone ?? a.name.split('.').slice(-2).join('.')))].slice(0, 40);
    const at = new Map<string, string[]>();
    await pool(roots, 6, async (r) => {
      const host = (await dnsHost(r).catch(() => undefined))?.host, id = host && (DNS_TILE[host] ?? host);
      if (id && catalogProvider(id) && !have.has(id)) at.set(id, [...(at.get(id) ?? []), r]);
    });
    const out: { provider: string; name: string; why: string; examples?: string[]; href?: string }[] = [...at].map(([id, domains]) => ({
      provider: id, name: catalogProvider(id)!.name, why: `${domains.length} domain${domains.length > 1 ? 's use' : ' uses'} ${catalogProvider(id)!.name} for DNS`, examples: domains.sort().slice(0, 3),
    }));
    for (const key of new Set(assets.filter((a) => a.m.owner === 'coolify' && a.m.server?.startsWith('unit7:')).map((a) => a.m.server!))) {
      const serverId = key.slice(6), name = all<{ name: string }>(ctx.db, 'SELECT name FROM servers WHERE id = ? AND org_id = ?', serverId, ctx.orgId)[0]?.name;
      if (name && !have.has(`coolify:${serverId}`)) out.push({ provider: 'coolify', name: 'Coolify', why: `Coolify is on ${name}`, href: `/servers/${serverId}#coolify-connect` });
    }
    return out;
  },
});
