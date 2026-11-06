// Resend, the sender Unit7 connects. A key talks to its REST API; a one-click sign-in talks to its hosted MCP server, whose
// domain tools answer in plain text, so that text is read here. Every call is Unit7's own: an AI never holds either.
// https://resend.com/docs/api-reference/domains/create-domain and https://github.com/resend/resend-mcp
import type { Ctx } from '../tools/runtime.ts';
import { Unit7Error } from '../errors.ts';
import { assertReachable } from '../netguard.ts';
import { mcpText } from './clouds.ts';
import { bearerFor, isOAuthAccount } from './mcp-oauth.ts';

export const RESEND_API = () => process.env.UNIT7_RESEND_API ?? 'https://api.resend.com'; // overridable for offline tests
export interface ResendRecord { record?: string; name: string; type: string; value: string; priority?: number; status?: string }
export interface ResendDomain { id: string; name: string; status: string; records: ResendRecord[] }

async function rs<T = any>(ctx: Ctx, acc: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await bearerFor(ctx, 'resend', acc);
  // fetch refuses a header with anything else in it, and that would read as "no answer"
  if (/[^\x21-\x7e]/.test(token)) throw new Unit7Error('resend_auth', 'The Resend key has a stray character in it, like a space or a curly quote. Paste it again in Connections → Resend.', 400);
  await assertReachable(new URL(RESEND_API()).hostname);
  const res = await fetch(`${RESEND_API()}${path}`, { method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(30_000) })
    .catch((e: Error) => { throw new Unit7Error('resend_unreachable', `Unit7 couldn’t reach Resend (${e.name === 'TimeoutError' ? 'it took too long' : 'no answer'}). Check the internet connection and try again.`, 502); });
  const data = await res.json().catch(() => ({})) as { message?: string; name?: string };
  // a send-only key is a good key, so the account isn't marked as refused
  if (data.name === 'restricted_api_key') throw new Unit7Error('resend_key', 'This Resend key can only send email. Setting up a domain takes a Full access key: make one at resend.com/api-keys, then add it in Connections → Resend.', 403);
  if (res.status === 401 || data.name === 'invalid_api_key') throw new Unit7Error('resend_auth', `Resend refused the key (${data.message ?? res.status}). Check it in Connections → Resend.`, 401);
  if (res.status === 429) throw new Unit7Error('rate_limited', 'Resend asked Unit7 to slow down (429). Try again in a minute.', 429);
  if (!res.ok) throw new Unit7Error('resend_error', `Resend: ${(data.message ?? res.statusText).slice(0, 300)}`, 502);
  return data as T;
}

const viaMcp = (ctx: Ctx, acc: string) => isOAuthAccount(ctx.credentialFor('resend', acc).account.meta);
// a name counts only right above its ID and status: a record's Name line is followed by its Value
const heads = (t: string) => [...t.matchAll(/^Name: ([^\n]+)\nID: ([^\n]+)\nStatus: ([^\n]+)/gm)].map((m) => ({ name: m[1]!.trim().toLowerCase(), id: m[2]!.trim(), status: m[3]!.trim() }));
function domainOf(t: string): ResendDomain {
  const h = heads(t)[0];
  if (!h) throw new Unit7Error('resend_error', 'Resend’s one-click sign-in answered in a way Unit7 can’t read. Use a key instead: Connections → Resend → Use a key.', 502);
  const records = [...t.matchAll(/^(.+) \((TXT|MX|CNAME)\):\n\s+Name: ([^\n]*)\n\s+Value: ([^\n]*)\n\s+TTL: [^\n]*\n\s+Status: ([^\n]*)(?:\n\s+Priority: (\d+))?/gm)]
    .map((m) => ({ record: m[1]!.trim(), type: m[2]!, name: m[3]!.trim(), value: m[4]!.trim(), status: m[5]!.trim(), ...(m[6] && { priority: Number(m[6]) }) }));
  return { ...h, records };
}

export const resend = {
  list: async (ctx: Ctx, acc: string): Promise<{ id: string; name: string }[]> => (viaMcp(ctx, acc) ? heads(await mcpText(ctx, acc, 'list-domains')) : (await rs<{ data?: { id: string; name: string }[] }>(ctx, acc, '/domains')).data ?? []),
  get: async (ctx: Ctx, acc: string, id: string): Promise<ResendDomain> => (viaMcp(ctx, acc) ? domainOf(await mcpText(ctx, acc, 'get-domain', { id })) : rs<ResendDomain>(ctx, acc, `/domains/${encodeURIComponent(id)}`)),
  find: async (ctx: Ctx, acc: string, name: string) => { const hit = (await resend.list(ctx, acc)).find((d) => d.name.toLowerCase() === name); return hit && resend.get(ctx, acc, hit.id); },
  create: async (ctx: Ctx, acc: string, name: string, region?: string): Promise<ResendDomain> => (viaMcp(ctx, acc) ? domainOf(await mcpText(ctx, acc, 'create-domain', { name, ...(region && { region }) })) : rs<ResendDomain>(ctx, acc, '/domains', { body: { name, ...(region && { region }) } })),
  verify: async (ctx: Ctx, acc: string, id: string) => { if (viaMcp(ctx, acc)) await mcpText(ctx, acc, 'verify-domain', { id }); else await rs(ctx, acc, `/domains/${encodeURIComponent(id)}/verify`, { method: 'POST' }); },
  // a key that can only send, and only from this domain: what an app gets, never the account's own. Resend shows it once.
  async sendingKey(ctx: Ctx, acc: string, domainId: string, name: string): Promise<string> {
    const token = viaMcp(ctx, acc) ? /Token: (re_\S+)/.exec(String(await mcpText(ctx, acc, 'create-api-key', { name, permission: 'sending_access', domainId })))?.[1]
      : (await rs<{ token?: string }>(ctx, acc, '/api-keys', { body: { name, permission: 'sending_access', domain_id: domainId } })).token;
    if (!token) throw new Unit7Error('resend_error', 'Resend didn’t hand back a sending key. Make one at resend.com/api-keys and bring it with smtpPassword.', 502);
    ctx.redactor.add(token, 'a Resend sending key');
    return token;
  },
  send: async (ctx: Ctx, acc: string, mail: { to: string; subject: string; text: string; from?: string }) => { if (viaMcp(ctx, acc)) await mcpText(ctx, acc, 'send-email', mail); else await rs(ctx, acc, '/emails', { body: { ...mail, from: mail.from ?? 'onboarding@resend.dev' } }); },
};
